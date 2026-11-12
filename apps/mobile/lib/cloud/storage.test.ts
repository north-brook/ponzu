import { describe, expect, test } from "bun:test";
import { SESSION_KEY } from "@ponzu/client";
import {
  CHUNK_BYTES,
  chunk,
  chunkedStorage,
  INSTALL_ID_KEY,
  installId,
  MAX_CHUNKS,
  type SecureStoreLike,
  wipeAfterReinstall,
} from "./storage";

/** The Keychain as a Map, which can be told to fail its next write after `n` more succeed. */
class FakeKeychain implements SecureStoreLike {
  readonly items = new Map<string, string>();
  writes: string[] = [];
  private failAfter: number | null = null;
  /** The longest value ever written, in bytes: the Keychain's limit is what this guards. */
  largest = 0;

  crashAfter(n: number) {
    this.failAfter = n;
  }

  async getItemAsync(key: string) {
    return this.items.get(key) ?? null;
  }

  async setItemAsync(key: string, value: string) {
    if (this.failAfter !== null) {
      if (this.failAfter === 0) throw new Error("killed");
      this.failAfter--;
    }
    this.largest = Math.max(this.largest, new TextEncoder().encode(value).length);
    this.writes.push(key);
    this.items.set(key, value);
    if (key === this.killAfterWriting) {
      this.killAfterWriting = null;
      this.armed = true;
    }
  }

  /** Once `key` is written, the next delete throws: the app killed just after that write. */
  killAfterWriting: string | null = null;
  private armed = false;

  async deleteItemAsync(key: string) {
    if (this.armed) {
      this.armed = false;
      throw new Error("killed");
    }
    this.items.delete(key);
  }
}

/** A session as large as a real one: two JWTs, a refresh token and the profile. */
const session = (tag: string) =>
  JSON.stringify({
    accessToken: `eyJ${tag}.${"a".repeat(1200)}`,
    refreshToken: `rt_${tag}${"b".repeat(40)}`,
    user: { id: "usr_1", githubLogin: "maya", name: "Maya Lín ✨", avatarUrl: null },
    idToken: "c".repeat(1100),
  });

describe("chunks", () => {
  test("a value is cut into pieces of at most 1,800 bytes, never inside a character", () => {
    const text = `${"é".repeat(1000)}${"x".repeat(10)}✨`;
    const pieces = chunk(text);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect(new TextEncoder().encode(piece).length).toBeLessThanOrEqual(CHUNK_BYTES);
    }
    expect(chunk("")).toEqual([""]);
  });

  test("a 2.5 KB session is written in chunks and read back whole", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    const value = session("one");
    expect(value.length).toBeGreaterThan(2_400);
    await storage.set(SESSION_KEY, value);
    expect(await storage.get(SESSION_KEY)).toBe(value);
    expect(keychain.largest).toBeLessThanOrEqual(CHUNK_BYTES + 1);
    // The head comes last: only once every chunk is down does the key stand for the value.
    expect(keychain.writes.at(-1)).toBe(SESSION_KEY);
    expect(keychain.writes.slice(0, -1)).toEqual(["ponzu.session.1.0", "ponzu.session.1.1"]);
  });

  test("a small value is written whole, under its key", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    await storage.set("ponzu.small", "hello");
    expect(keychain.writes).toEqual(["ponzu.small"]);
    expect(await storage.get("ponzu.small")).toBe("hello");
    expect(await storage.get("ponzu.missing")).toBeNull();
  });

  test("a rewrite leaves no chunk of the old value behind", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    await storage.set(SESSION_KEY, session("one"));
    await storage.set(SESSION_KEY, session("two"));
    expect(await storage.get(SESSION_KEY)).toBe(session("two"));
    expect([...keychain.items.keys()].sort()).toEqual([
      "ponzu.session",
      "ponzu.session.2.0",
      "ponzu.session.2.1",
    ]);
    await storage.set(SESSION_KEY, "short");
    expect([...keychain.items.keys()]).toEqual(["ponzu.session"]);
    await storage.delete(SESSION_KEY);
    expect(keychain.items.size).toBe(0);
  });

  for (let survive = 0; survive <= 2; survive++) {
    test(`a crash after ${survive} of a rewrite's writes keeps the old value whole`, async () => {
      const keychain = new FakeKeychain();
      const storage = chunkedStorage(keychain);
      await storage.set(SESSION_KEY, session("old"));
      keychain.crashAfter(survive);
      await expect(storage.set(SESSION_KEY, session("new"))).rejects.toThrow("killed");
      // The app comes back with a new storage over the same Keychain.
      const again = chunkedStorage(keychain);
      expect(await again.get(SESSION_KEY)).toBe(session("old"));
    });
  }

  test("what a crashed rewrite left is swept by the next write or delete", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    await storage.set(SESSION_KEY, session("old"));
    keychain.crashAfter(1);
    await expect(storage.set(SESSION_KEY, session("new"))).rejects.toThrow("killed");
    expect(keychain.items.has("ponzu.session.2.0")).toBe(true);
    await storage.delete(SESSION_KEY);
    expect(keychain.items.size).toBe(0);
  });

  test("a crash after the new head, before the old chunks go, leaves nothing once deleted", async () => {
    for (const next of [session("new"), "short"]) {
      const keychain = new FakeKeychain();
      const storage = chunkedStorage(keychain);
      await storage.set(SESSION_KEY, session("old"));
      await storage.set(SESSION_KEY, session("older"));
      // The new value is down; the old generation's chunks are not yet deleted.
      keychain.killAfterWriting = SESSION_KEY;
      await expect(storage.set(SESSION_KEY, next)).rejects.toThrow("killed");
      const again = chunkedStorage(keychain);
      expect(await again.get(SESSION_KEY)).toBe(next);
      // Signing out, or the reinstall wipe: no piece of either token stays.
      await again.delete(SESSION_KEY);
      expect([...keychain.items.keys()]).toEqual([]);
    }
  });

  test("a head whose chunks are gone reads as nothing", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    await storage.set(SESSION_KEY, session("one"));
    keychain.items.delete("ponzu.session.1.1");
    expect(await storage.get(SESSION_KEY)).toBeNull();
  });

  test("a value too large for any session is refused, and the old one stays", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    await storage.set(SESSION_KEY, "kept");
    await expect(
      storage.set(SESSION_KEY, "x".repeat(CHUNK_BYTES * MAX_CHUNKS + 1)),
    ).rejects.toThrow();
    expect(await storage.get(SESSION_KEY)).toBe("kept");
  });

  test("a read never sees half a write", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    await storage.set(SESSION_KEY, session("one"));
    const writing = storage.set(SESSION_KEY, session("two"));
    const read = storage.get(SESSION_KEY);
    await writing;
    expect(await read).toBe(session("two"));
  });
});

describe("reinstalls", () => {
  const marker = () => {
    let present = false;
    return {
      exists: () => present,
      create: () => {
        present = true;
      },
    };
  };

  test("the first launch after an install forgets the session and keeps the install id", async () => {
    const keychain = new FakeKeychain();
    const storage = chunkedStorage(keychain);
    // What the last install left in the Keychain, which outlives deleting the app.
    await storage.set(SESSION_KEY, session("left"));
    const id = await installId(storage, () => "4F1C2A9E-0B3D-4E5F-8A7B-6C5D4E3F2A1B");
    const installed = marker();

    expect(await wipeAfterReinstall(storage, installed)).toBe(true);
    expect(await storage.get(SESSION_KEY)).toBeNull();
    expect(await storage.get(INSTALL_ID_KEY)).toBe(id);
    expect([...keychain.items.keys()]).toEqual([INSTALL_ID_KEY]);

    // Every launch after that keeps what is there.
    await storage.set(SESSION_KEY, session("mine"));
    expect(await wipeAfterReinstall(storage, installed)).toBe(false);
    expect(await storage.get(SESSION_KEY)).toBe(session("mine"));
  });

  test("the install id is 32 hex characters, made once", async () => {
    const storage = chunkedStorage(new FakeKeychain());
    let made = 0;
    const uuid = () => {
      made++;
      return "4F1C2A9E-0B3D-4E5F-8A7B-6C5D4E3F2A1B";
    };
    const id = await installId(storage, uuid);
    expect(id).toBe("4f1c2a9e0b3d4e5f8a7b6c5d4e3f2a1b");
    expect(await installId(storage, uuid)).toBe(id);
    expect(made).toBe(1);
  });
});
