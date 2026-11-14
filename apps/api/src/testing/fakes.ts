import { createHash } from "node:crypto";
import type { Clock } from "@ponzu/sandbox";
import type { Anthropic } from "../deps/anthropic.ts";
import type { Poke, RunnerTool } from "../deps/poke.ts";
import type { LiveQuery, RealtimeSealer, SealedQuery } from "../deps/realtime.ts";
import {
  MAX_DELETE_KEYS,
  MAX_LIST_KEYS,
  type ObjectStorage,
  type PresignedPut,
  type StoredHead,
  type StoredList,
  type StoredObject,
  uploadHeaders,
} from "../deps/storage.ts";
import { UpstreamError } from "../http/errors.ts";

/** An object as `MemoryStorage` holds it. */
export interface MemoryObject {
  body: Uint8Array;
  /** The headers it was stored with, which it is served with. */
  headers: Record<string, string>;
  sha256: string | null;
  /**
   * When it was written, by the test's clock: set by a PUT and a copy. One a test puts in
   * `objects` itself has none unless it gives one, and a list answers it as not said.
   */
  modifiedAt?: number;
}

/**
 * Object storage that is a map, and that holds a presigned PUT to what R2 does: the address
 * takes one PUT before it runs out (by the test's clock), carrying every signed header with the
 * value it was signed with, of exactly the declared size and SHA-256. `fetch` serves those
 * addresses; hand it to whatever PUTs the bytes (the runner's client takes one). `objects` is
 * there for a test to look into.
 */
export class MemoryStorage implements ObjectStorage {
  static readonly ORIGIN = "https://storage.test";
  readonly objects = new Map<string, MemoryObject>();
  readonly #signed = new Map<string, { key: string; object: StoredObject; expiresAt: number }>();
  readonly #reads = new Map<string, { key: string; expiresAt: number }>();
  readonly #clock: Clock;
  #next = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async presignPut(key: string, object: StoredObject, expiresIn: number): Promise<PresignedPut> {
    const signature = `sig${++this.#next}`;
    this.#signed.set(signature, { key, object, expiresAt: this.#clock.now() + expiresIn * 1000 });
    const url = new URL(`/${key}`, MemoryStorage.ORIGIN);
    url.searchParams.set("signature", signature);
    return { url: url.toString(), headers: uploadHeaders(object) };
  }

  async presignGet(key: string, expiresIn: number): Promise<string> {
    const signature = `get${++this.#next}`;
    this.#reads.set(signature, { key, expiresAt: this.#clock.now() + expiresIn * 1000 });
    const url = new URL(`/${key}`, MemoryStorage.ORIGIN);
    url.searchParams.set("signature", signature);
    return url.toString();
  }

  /** Serves the addresses `presignPut` and `presignGet` made, answering as R2 does. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const read = this.#reads.get(new URL(request.url).searchParams.get("signature") ?? "");
    if (read) {
      if (request.method !== "GET") return refuse(403, "SignatureDoesNotMatch");
      if (this.#clock.now() > read.expiresAt) return refuse(403, "AccessDenied");
      const found = this.objects.get(read.key);
      if (!found) return refuse(404, "NoSuchKey");
      return new Response(Buffer.from(found.body), { status: 200, headers: found.headers });
    }
    const signed = this.#signed.get(new URL(request.url).searchParams.get("signature") ?? "");
    if (request.method !== "PUT" || !signed) return refuse(403, "SignatureDoesNotMatch");
    if (this.#clock.now() > signed.expiresAt) return refuse(403, "AccessDenied");
    const expected = uploadHeaders(signed.object);
    for (const [name, value] of Object.entries(expected)) {
      if (request.headers.get(name) !== value) return refuse(403, "SignatureDoesNotMatch");
    }
    if (request.headers.has("authorization")) return refuse(400, "InvalidArgument");
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength !== signed.object.size) return refuse(403, "SignatureDoesNotMatch");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== signed.object.sha256) return refuse(400, "BadDigest");
    this.objects.set(signed.key, {
      body,
      headers: expected,
      sha256,
      modifiedAt: this.#clock.now(),
    });
    return new Response(null, { status: 200 });
  };

  /**
   * The status every `head` fails with, as R2 answers a bad token (403) or a fault (500), or
   * null to answer from the map. With no status at all (0), it acts out R2 not answering.
   */
  headFails: number | null = null;

  async head(key: string): Promise<StoredHead | null> {
    if (this.headFails !== null) {
      throw new UpstreamError(
        "storage",
        "HEAD an object failed",
        this.headFails === 0 ? {} : { status: this.headFails },
      );
    }
    const found = this.objects.get(key);
    if (!found) return null;
    return {
      size: found.body.byteLength,
      contentType: found.headers["content-type"] ?? null,
      sha256: found.sha256,
    };
  }

  async copy(from: string, to: string) {
    const found = this.objects.get(from);
    // As R2 answers a copy whose source is not there: 404, naming no key.
    if (!found) throw new UpstreamError("storage", "COPY an object answered 404", { status: 404 });
    // R2 keeps the headers and not the checksum.
    this.objects.set(to, { ...found, sha256: null, modifiedAt: this.#clock.now() });
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  /** Every `list` and `deleteMany` call, oldest first, for a test to count round trips. */
  readonly bulk: { op: "list" | "deleteMany"; prefix?: string; after?: string; keys?: number }[] =
    [];
  /**
   * How many of the next `deleteMany` calls fail after removing half their keys, as R2 does
   * when it answers some keys with an error.
   */
  failDeletes = 0;

  async list(prefix: string, { after }: { after?: string } = {}): Promise<StoredList> {
    this.bulk.push({ op: "list", prefix, ...(after === undefined ? {} : { after }) });
    // S3 orders keys by their UTF-8 bytes; for the ASCII keys the API makes, that is this.
    const all = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && (after === undefined || key > after))
      .sort();
    const keys = all.slice(0, MAX_LIST_KEYS);
    const objects = keys.map((key) => {
      const at = this.objects.get(key)!.modifiedAt;
      return { key, modifiedAt: at === undefined ? null : new Date(at) };
    });
    return { keys, objects, truncated: all.length > MAX_LIST_KEYS };
  }

  async deleteMany(keys: readonly string[]): Promise<void> {
    this.bulk.push({ op: "deleteMany", keys: keys.length });
    if (keys.length > MAX_DELETE_KEYS) throw new Error("Storage refuses over 1,000 keys.");
    if (this.failDeletes > 0) {
      this.failDeletes--;
      for (const key of keys.slice(0, Math.floor(keys.length / 2))) this.objects.delete(key);
      throw new UpstreamError("storage", "DELETE MANY could not remove some objects");
    }
    for (const key of keys) this.objects.delete(key);
  }
}

function refuse(status: number, code: string): Response {
  return new Response(`<Error><Code>${code}</Code></Error>`, { status });
}

/**
 * Anthropic, as far as the API asks it: it takes the keys in `keys` and no others. Set
 * `failing` to act out Anthropic not answering.
 */
export class FakeAnthropic implements Anthropic {
  readonly keys = new Set<string>();
  /** Every key asked about, oldest first. */
  readonly asked: string[] = [];
  failing = false;
  /** Whether Anthropic takes Ponzu's own key. Set false to act out a revoked one. */
  ownKeyAccepted = true;

  async acceptsApiKey(key: string): Promise<boolean> {
    this.asked.push(key);
    if (this.failing) throw new UpstreamError("anthropic", "Anthropic did not answer.");
    return this.keys.has(key);
  }

  async acceptsOwnKey(): Promise<boolean> {
    if (this.failing) throw new UpstreamError("anthropic", "Anthropic did not answer.");
    return this.ownKeyAccepted;
  }
}

/**
 * Pokes, recorded instead of sent, each with the port's bearer token it carried. Set `failing` to
 * act out a runner that cannot be reached at all (createPoke's own retry of a 502 or 503 is
 * tested against a fetch in wake.test.ts).
 */
export class FakePoke {
  readonly pokes: { url: string; token: string }[] = [];
  failing = false;

  readonly poke: Poke = async (target) => {
    this.pokes.push(target);
    if (this.failing) throw new Error("The runner could not be reached.");
  };
}

/**
 * A sealer that seals nothing: the capability is the query, readable, so a test can assert
 * exactly what SQL and which values a route authorized. `sealed` keeps every one, oldest first.
 */
export class FakeSealer implements RealtimeSealer {
  readonly url = "https://realtime.test/";
  readonly sealed: LiveQuery[] = [];
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Set to act out a sealer that cannot seal, as with a malformed Realtime secret. */
  failing = false;

  async seal(query: LiveQuery): Promise<SealedQuery> {
    if (this.failing) throw new Error("The fake sealer was told to fail.");
    this.sealed.push(query);
    const text = JSON.stringify(query);
    return {
      capability: `sealed:${text}`,
      queryFingerprint: `fingerprint:${text}`,
      expiresAt: this.#clock.now() + 60_000,
    };
  }
}

/**
 * A driven canvas's runner, as the API reaches its `POST /tool`: each call recorded, and answered
 * by `answer` (a tool's text, by default).
 */
export class FakeRunnerTool {
  readonly calls: {
    url: string;
    name: string;
    args: unknown;
    driver: { name: string; client: string };
  }[] = [];
  answer: (name: string, args: unknown) => { status: number; body: unknown } = (name) => ({
    status: 200,
    body: { content: [{ type: "text", text: `Ran ${name}.` }], isError: false },
  });
  readonly tool: RunnerTool = async (target, call) => {
    this.calls.push({ url: target.url, ...call });
    return this.answer(call.name, call.args);
  };
}
