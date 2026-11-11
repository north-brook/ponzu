import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cipher, tokenStorage } from "./token-store.ts";

const dir = mkdtempSync(join(tmpdir(), "ponzu-tokens-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for safeStorage: reversible, and plainly not the text. */
const cipher = (available = true): Cipher => ({
  available: () => available,
  encrypt: (text) => Buffer.from(text, "utf8").reverse(),
  decrypt: (data) => Buffer.from(data).reverse().toString("utf8"),
});

test("tokens are kept encrypted in one file only the person can read", async () => {
  const file = join(dir, "a/session.bin");
  const { storage, persistence } = tokenStorage(file, cipher());
  expect(persistence).toBe("keychain");
  await storage.set("ponzu.session", '{"refreshToken":"rt_secret"}');
  expect(readFileSync(file, "utf8")).not.toContain("rt_secret");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  // A new launch reads what the last one wrote.
  const again = tokenStorage(file, cipher()).storage;
  expect(await again.get("ponzu.session")).toBe('{"refreshToken":"rt_secret"}');
  // Written through a file beside it, which never stays behind.
  expect(readdirSync(join(dir, "a"))).toEqual(["session.bin"]);
  await again.delete("ponzu.session");
  expect(await again.get("ponzu.session")).toBeNull();
  expect(readdirSync(join(dir, "a"))).toEqual([]);
});

test("a file that can't be decrypted (the keychain was reset) holds nothing", async () => {
  const file = join(dir, "b/session.bin");
  await tokenStorage(file, cipher()).storage.set("ponzu.session", "x");
  const broken: Cipher = {
    ...cipher(),
    decrypt: () => {
      throw new Error("Error while decrypting the ciphertext");
    },
  };
  expect(await tokenStorage(file, broken).storage.get("ponzu.session")).toBeNull();
});

test("without a keychain nothing is written down: the session lasts until Ponzu quits", async () => {
  const file = join(dir, "c/session.bin");
  const { storage, persistence } = tokenStorage(file, cipher(false));
  expect(persistence).toBe("memory");
  await storage.set("ponzu.session", "x");
  expect(await storage.get("ponzu.session")).toBe("x");
  expect(() => statSync(file)).toThrow();
});
