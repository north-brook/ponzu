import type { Clock } from "@ponzu/sandbox";
import type { LiveQuery, RealtimeSealer, SealedQuery } from "../deps/realtime.ts";
import type { ObjectStorage } from "../deps/storage.ts";

/** Object storage that is a map. `objects` is there for a test to look into. */
export class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body, contentType });
  }

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
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
