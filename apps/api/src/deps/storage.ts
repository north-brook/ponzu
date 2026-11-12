import { createHash } from "node:crypto";
import type { Clock } from "@ponzu/sandbox";
import { UpstreamError } from "../http/errors.ts";
import type { Fetch } from "./fetch.ts";
import { type Credentials, canonicalQuery, encodePath, presign, signHeaders } from "./sigv4.ts";

/**
 * Where bytes live: a canvas's assets, previews and exports, in Cloudflare R2 under the canvas's
 * asset key (docs/cloud.md, "Assets and previews"). Bytes never pass through the API: an
 * uploader is handed an address that takes exactly the bytes it declared, and the API looks
 * at what arrived before it records anything.
 */
export interface ObjectStorage {
  /**
   * An address that takes one PUT of exactly these bytes to `key` for `expiresIn` seconds. The
   * uploader sends `headers` as they are, and no `Authorization`; storage refuses anything
   * else: another type, size or SHA-256, or a missing header.
   */
  presignPut(key: string, object: StoredObject, expiresIn: number): Promise<PresignedPut>;
  /**
   * An address that reads `key` for `expiresIn` seconds, with no other credential: how a
   * runner reads back a checkpoint stored where nothing serves it publicly.
   */
  presignGet(key: string, expiresIn: number): Promise<string>;
  /** What is at `key`, or null when nothing is. */
  head(key: string): Promise<StoredHead | null>;
  /** Puts a copy of `from` at `to`, with the headers `from` was stored with. */
  copy(from: string, to: string): Promise<void>;
  /** Removes `key`. Nothing there is fine. */
  delete(key: string): Promise<void>;
  /**
   * Up to `MAX_LIST_KEYS` keys that start with `prefix`, in order, each one after `after` when
   * it is given. `truncated` when there are more: ask again with the last key as `after`.
   */
  list(prefix: string, options?: { after?: string }): Promise<StoredList>;
  /**
   * Removes every one of `keys`, at most `MAX_DELETE_KEYS` at once. Nothing at a key is fine.
   * Throws when storage could not remove one, after removing the rest.
   */
  deleteMany(keys: readonly string[]): Promise<void>;
}

/** One page of the keys under a prefix. */
export interface StoredList {
  keys: string[];
  truncated: boolean;
}

/** The most keys one `list` answers with, and one `deleteMany` takes: S3's own limits. */
export const MAX_LIST_KEYS = 1000;
export const MAX_DELETE_KEYS = 1000;

/** What an upload must be, and the headers it is served with afterwards. */
export interface StoredObject {
  contentType: string;
  size: number;
  /** Hex. */
  sha256: string;
  cacheControl: string;
  /** `attachment` makes a browser that opens the address save the file rather than show it. */
  contentDisposition?: string;
}

/** What storage says of an object it holds. */
export interface StoredHead {
  size: number;
  contentType: string | null;
  /** Hex, as the upload declared it and storage checked it. Null when it was stored without. */
  sha256: string | null;
}

export interface PresignedPut {
  url: string;
  /** Exactly these, with the bytes. `Content-Length` is signed too, and the client sets it. */
  headers: Record<string, string>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const TIMEOUT_MS = 10_000;

/** `ObjectStorage` on R2's S3 API, signed with SigV4. */
export function createR2Storage({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  fetch,
  clock,
}: R2Config & { fetch: Fetch; clock: Clock }): ObjectStorage {
  const credentials: Credentials = { accessKeyId, secretAccessKey, region: "auto" };
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const objectPath = (key: string) => `/${bucket}/${encodePath(key)}`;
  const urlOf = (key: string) => new URL(objectPath(key), endpoint);

  async function send(
    method: string,
    url: URL,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<Response> {
    // Sent exactly as it is signed, so a listed key with a space in it reads back the same.
    if (url.search) url.search = canonicalQuery(url.searchParams);
    const signed = await signHeaders(credentials, { method, url, headers, now: clock.now() });
    try {
      return await fetch(url.toString(), {
        method,
        headers: signed,
        ...(body === undefined ? {} : { body }),
        signal: clock.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      throw new UpstreamError("storage", `${method} an object did not answer`, { cause });
    }
  }

  const call = (method: string, key: string, headers: Record<string, string> = {}) =>
    send(method, urlOf(key), headers);

  /** The bucket itself, for the requests that are about many objects. */
  const bucketUrl = () => new URL(`/${bucket}`, endpoint);

  function refused(method: string, response: Response): UpstreamError {
    return new UpstreamError("storage", `${method} an object answered ${response.status}`, {
      status: response.status,
    });
  }

  return {
    async presignPut(key, object, expiresIn) {
      const headers = uploadHeaders(object);
      const url = await presign(credentials, {
        method: "PUT",
        url: urlOf(key),
        headers: { ...headers, "content-length": String(object.size) },
        now: clock.now(),
        expiresIn,
      });
      return { url: url.toString(), headers };
    },

    async presignGet(key, expiresIn) {
      const url = await presign(credentials, {
        method: "GET",
        url: urlOf(key),
        headers: {},
        now: clock.now(),
        expiresIn,
      });
      return url.toString();
    },

    async head(key) {
      const response = await call("HEAD", key, {
        // Without this a text type (an SVG) comes back as if compressed, with no length.
        "accept-encoding": "identity",
        // S3 sends the checksum only when asked. (R2 sends it either way, as of November 2026.)
        "x-amz-checksum-mode": "ENABLED",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw refused("HEAD", response);
      const checksum = response.headers.get("x-amz-checksum-sha256");
      return {
        size: Number(response.headers.get("content-length")),
        contentType: response.headers.get("content-type"),
        sha256: checksum ? Buffer.from(checksum, "base64").toString("hex") : null,
      };
    },

    async copy(from, to) {
      const response = await call("PUT", to, { "x-amz-copy-source": objectPath(from) });
      await response.body?.cancel();
      if (!response.ok) throw refused("COPY", response);
    },

    async delete(key) {
      const response = await call("DELETE", key);
      if (!response.ok && response.status !== 404) throw refused("DELETE", response);
    },

    async list(prefix, { after } = {}) {
      // ListObjectsV2. `start-after` rather than a continuation token: the last key is all a
      // caller has to keep, and it means the same thing on any later call.
      const url = bucketUrl();
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("max-keys", String(MAX_LIST_KEYS));
      if (after !== undefined) url.searchParams.set("start-after", after);
      const response = await send("GET", url);
      if (!response.ok) {
        await response.body?.cancel();
        throw refused("LIST", response);
      }
      return parseList(await response.text());
    },

    async deleteMany(keys) {
      if (keys.length === 0) return;
      if (keys.length > MAX_DELETE_KEYS) {
        throw new Error(`Storage deletes at most ${MAX_DELETE_KEYS} keys at once.`);
      }
      // DeleteObjects. S3 takes its body only with a checksum of it, which is signed with the
      // rest of the headers.
      const body = deleteBody(keys);
      const url = bucketUrl();
      url.searchParams.set("delete", "");
      const response = await send(
        "POST",
        url,
        {
          "content-type": "application/xml",
          "x-amz-checksum-sha256": createHash("sha256").update(body).digest("base64"),
        },
        body,
      );
      const text = await response.text();
      if (!response.ok) throw refused("DELETE MANY", response);
      const failed = parseDeleteErrors(text);
      if (failed.length > 0) {
        throw new UpstreamError(
          "storage",
          `DELETE MANY could not remove ${failed.length} of ${keys.length} objects (${failed[0]})`,
          { status: response.status },
        );
      }
    },
  };
}

/** The body of a DeleteObjects request. Quiet: storage answers only with what it could not do. */
export function deleteBody(keys: readonly string[]): string {
  const objects = keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${objects}</Delete>`;
}

/** The keys, and whether there are more, from a ListObjectsV2 answer. */
export function parseList(xml: string): StoredList {
  const keys = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((contents) => {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(contents[1]!);
    if (!key) throw new UpstreamError("storage", "LIST answered an object with no key");
    return unescapeXml(key[1]!);
  });
  return { keys, truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml) };
}

/**
 * The codes of what a DeleteObjects answer says it could not remove. A key that held nothing is
 * not among them: S3 counts it deleted.
 */
export function parseDeleteErrors(xml: string): string[] {
  return [...xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].map((error) => {
    const code = /<Code>([\s\S]*?)<\/Code>/.exec(error[1]!);
    return code ? unescapeXml(code[1]!) : "unknown";
  });
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const XML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]!);
}

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return XML_NAMED[name]!;
  });
}

/**
 * The headers an upload is signed with and must carry. The type, the cache rule and the
 * disposition are kept with the object and sent with it whenever it is served. The SHA-256 is
 * checked by storage against the bytes as they arrive.
 */
export function uploadHeaders(object: StoredObject): Record<string, string> {
  return {
    "content-type": object.contentType,
    "cache-control": object.cacheControl,
    "x-amz-checksum-sha256": Buffer.from(object.sha256, "hex").toString("base64"),
    ...(object.contentDisposition ? { "content-disposition": object.contentDisposition } : {}),
  };
}
