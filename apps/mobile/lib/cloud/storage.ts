import { type KeyValueStorage, SESSION_KEY } from "@ponzu/client";

/*
 * The session's tokens in the Keychain (docs/mobile.md, "The Keychain"). expo-secure-store is
 * the store; this adds three things it lacks:
 *
 * - Size. Some iOS versions refused values over about 2,048 bytes, and a session is about 2.5 KB.
 *   A value over CHUNK_BYTES is written as chunks `<key>.<gen>.<i>`, then a head at `<key>` that
 *   names the generation, then the old generation's chunks are deleted. A crash at any point
 *   leaves the head naming chunks that are all there: the old value or the new one, whole.
 * - Reinstalls. A Keychain item outlives deleting the app, and a reinstalled phone should not
 *   come back signed in. A marker file (which does go with the app) tells a reinstall from a
 *   launch; on a reinstall the session is deleted and the install id kept.
 * - The install id: 32 random characters, made once per phone and kept across reinstalls. It
 *   goes only to `POST /v1/me/devices`.
 */

/** The little of expo-secure-store this uses, so tests can hand it a Map. */
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Whether the app has run since it was installed: a file in its documents. */
export interface InstallMarker {
  exists(): boolean | Promise<boolean>;
  create(): void | Promise<void>;
}

/** The largest value written whole, in UTF-8 bytes. */
export const CHUNK_BYTES = 1_800;
/** A value needing more chunks than this is refused: nothing Ponzu keeps comes close. */
export const MAX_CHUNKS = 8;
export const INSTALL_ID_KEY = "ponzu.installId";

/** Every stored value starts with one of these, so a head is never mistaken for a value. */
const WHOLE = "=";
const HEAD = "#";
/** The two generations a chunked value's pieces alternate between. */
const GENERATIONS = [1, 2] as const;

interface Head {
  gen: number;
  n: number;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** `text` cut into pieces of at most `max` UTF-8 bytes, never inside a character. */
export function chunk(text: string, max = CHUNK_BYTES): string[] {
  const pieces: string[] = [];
  let piece = "";
  let size = 0;
  for (const char of text) {
    const n = bytes(char);
    if (size + n > max && piece) {
      pieces.push(piece);
      piece = "";
      size = 0;
    }
    piece += char;
    size += n;
  }
  if (piece || !pieces.length) pieces.push(piece);
  return pieces;
}

function readHead(raw: string): Head | null {
  if (!raw.startsWith(HEAD)) return null;
  try {
    const head = JSON.parse(raw.slice(HEAD.length)) as Partial<Head>;
    return Number.isInteger(head.gen) && Number.isInteger(head.n)
      ? { gen: head.gen!, n: head.n! }
      : null;
  } catch {
    return null;
  }
}

const chunkKey = (key: string, gen: number, i: number) => `${key}.${gen}.${i}`;

/**
 * A `KeyValueStorage` over the Keychain that takes values of any size it is likely to see. Its
 * calls run one at a time, so a read never sees half a write.
 */
export function chunkedStorage(store: SecureStoreLike): KeyValueStorage {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  };

  const headOf = async (key: string) => {
    const raw = await store.getItemAsync(key);
    return raw === null ? null : readHead(raw);
  };
  /**
   * Every chunk of generation `gen`, from `from` on. Generations take turns (1, then 2, then 1),
   * so whatever a crashed write left (chunks a head never named, or an old generation's chunks
   * after the new head went down) is always in a generation the key doesn't name now, and is
   * swept by the next write or delete. No stray piece of a token outlives the value.
   */
  const sweep = async (key: string, gen: number, from = 0) => {
    for (let i = from; i < MAX_CHUNKS; i++) await store.deleteItemAsync(chunkKey(key, gen, i));
  };
  const sweepAll = async (key: string, except?: number) => {
    for (const gen of GENERATIONS) if (gen !== except) await sweep(key, gen);
  };

  return {
    get: (key) =>
      serial(async () => {
        const raw = await store.getItemAsync(key);
        if (raw === null) return null;
        if (raw.startsWith(WHOLE)) return raw.slice(WHOLE.length);
        const head = readHead(raw);
        if (!head) return null;
        let value = "";
        for (let i = 0; i < head.n; i++) {
          const piece = await store.getItemAsync(chunkKey(key, head.gen, i));
          // A head whose chunks are gone is nothing worth handing a session.
          if (piece === null) return null;
          value += piece;
        }
        return value;
      }),
    set: (key, value) =>
      serial(async () => {
        if (bytes(value) <= CHUNK_BYTES) {
          await store.setItemAsync(key, WHOLE + value);
          await sweepAll(key);
          return;
        }
        const pieces = chunk(value);
        if (pieces.length > MAX_CHUNKS) throw new Error(`Too large for the Keychain: ${key}`);
        const old = await headOf(key);
        const gen = old?.gen === 1 ? 2 : 1;
        await sweep(key, gen, pieces.length);
        for (const [i, piece] of pieces.entries()) {
          await store.setItemAsync(chunkKey(key, gen, i), piece);
        }
        // Only now does the key stand for the new value.
        await store.setItemAsync(key, HEAD + JSON.stringify({ gen, n: pieces.length }));
        await sweepAll(key, gen);
      }),
    delete: (key) =>
      serial(async () => {
        await store.deleteItemAsync(key);
        await sweepAll(key);
      }),
  };
}

/**
 * On the first launch after an install, forget any session an earlier install left in the
 * Keychain, then mark the install. The install id stays.
 */
export async function wipeAfterReinstall(
  storage: KeyValueStorage,
  marker: InstallMarker,
): Promise<boolean> {
  if (await marker.exists()) return false;
  await storage.delete(SESSION_KEY);
  await marker.create();
  return true;
}

/** This phone's install id, made the first time it is asked for. */
export async function installId(
  storage: KeyValueStorage,
  randomUUID: () => string,
): Promise<string> {
  const known = await storage.get(INSTALL_ID_KEY);
  if (known && /^[0-9a-f]{32}$/.test(known)) return known;
  const id = randomUUID().replaceAll("-", "").toLowerCase();
  await storage.set(INSTALL_ID_KEY, id);
  return id;
}

/**
 * `run`, shared and made once for good: every caller waits on the call in flight, and one that
 * succeeded is never made again. A call that failed is forgotten, so the next caller tries
 * again, rather than one failed Keychain write failing every Keychain call after it.
 */
export function onceUntilFailed(run: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | null = null;
  return () => {
    done ??= run().catch((error: unknown) => {
      done = null;
      throw error;
    });
    return done;
  };
}
