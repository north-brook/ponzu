import { createHash } from "node:crypto";
import type { Clock } from "@ponzu/sandbox";
import type { Poke } from "../deps/poke.ts";
import type { LiveQuery, RealtimeSealer, SealedQuery } from "../deps/realtime.ts";
import {
  type ObjectStorage,
  type PresignedPut,
  type StoredHead,
  type StoredObject,
  uploadHeaders,
} from "../deps/storage.ts";

/** An object as `MemoryStorage` holds it. */
export interface MemoryObject {
  body: Uint8Array;
  /** The headers it was stored with, which it is served with. */
  headers: Record<string, string>;
  sha256: string | null;
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

  /** Serves the addresses `presignPut` made, answering as R2 does. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
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
    this.objects.set(signed.key, { body, headers: expected, sha256 });
    return new Response(null, { status: 200 });
  };

  async head(key: string): Promise<StoredHead | null> {
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
    if (!found) throw new Error(`Nothing at ${from} to copy.`);
    // R2 keeps the headers and not the checksum.
    this.objects.set(to, { ...found, sha256: null });
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

function refuse(status: number, code: string): Response {
  return new Response(`<Error><Code>${code}</Code></Error>`, { status });
}

/** Pokes, recorded instead of sent. Set `failing` to act out a runner that cannot be reached. */
export class FakePoke {
  readonly pokes: { url: string; token: string | null }[] = [];
  failing = false;

  readonly poke: Poke = async (address) => {
    this.pokes.push(address);
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

  async seal(query: LiveQuery): Promise<SealedQuery> {
    this.sealed.push(query);
    const text = JSON.stringify(query);
    return {
      capability: `sealed:${text}`,
      queryFingerprint: `fingerprint:${text}`,
      expiresAt: this.#clock.now() + 60_000,
    };
  }
}
