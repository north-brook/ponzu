import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cipher, tokenStorage } from "./token-store.ts";

const dir = mkdtempSync(join(tmpdir(), "ponzu-tokens-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for safeStorage: reversible, plainly not the text, and counting keychain visits. */
function cipher(available = true) {
  const asked = { count: 0 };
  const visit = () => {
    asked.count++;
  };
  const c: Cipher = {
    available: () => {
      visit();
      return available;
    },
    encrypt: (text) => {
      visit();
      return Buffer.from(text, "utf8").reverse();
    },
    decrypt: (data) => {
      visit();
      return Buffer.from(data).reverse().toString("utf8");
    },
  };
  return { cipher: c, asked };
}

test("tokens are kept encrypted in one file only the person can read", async () => {
  const file = join(dir, "a/session.bin");
  const { storage, persistence } = tokenStorage(file, cipher().cipher);
  await storage.set("ponzu.session", '{"refreshToken":"rt_secret"}');
  expect(persistence()).toBe("keychain");
  expect(readFileSync(file, "utf8")).not.toContain("rt_secret");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  // A new launch reads what the last one wrote.
  const again = tokenStorage(file, cipher().cipher).storage;
  expect(await again.get("ponzu.session")).toBe('{"refreshToken":"rt_secret"}');
  // Written through a file beside it, which never stays behind.
  expect(readdirSync(join(dir, "a"))).toEqual(["session.bin"]);
  await again.delete("ponzu.session");
  expect(await again.get("ponzu.session")).toBeNull();
  expect(readdirSync(join(dir, "a"))).toEqual([]);
});

test("a launch with nobody signed in never asks the keychain", async () => {
  const { cipher: c, asked } = cipher();
  const { storage, persistence } = tokenStorage(join(dir, "never/session.bin"), c);
  expect(await storage.get("ponzu.session")).toBeNull();
  await storage.delete("ponzu.session");
  expect(persistence()).toBe("keychain");
  expect(asked.count).toBe(0);
});

test("a file that can't be decrypted (the keychain was reset) holds nothing", async () => {
  const file = join(dir, "b/session.bin");
  await tokenStorage(file, cipher().cipher).storage.set("ponzu.session", "x");
  const broken: Cipher = {
    ...cipher().cipher,
    decrypt: () => {
      throw new Error("Error while decrypting the ciphertext");
    },
  };
  expect(await tokenStorage(file, broken).storage.get("ponzu.session")).toBeNull();
});

test("without a keychain nothing is written down: the session lasts until Ponzu quits", async () => {
  const file = join(dir, "c/session.bin");
  const { storage, persistence } = tokenStorage(file, cipher(false).cipher);
  await storage.set("ponzu.session", "x");
  expect(persistence()).toBe("memory");
  expect(await storage.get("ponzu.session")).toBe("x");
  expect(() => statSync(file)).toThrow();
});

test("signing out without a keychain also forgets a session an earlier launch kept in it", async () => {
  const file = join(dir, "d/session.bin");
  await tokenStorage(file, cipher().cipher).storage.set("ponzu.session", "old");
  // The keychain has gone since: this launch signs in again, into memory, then signs out.
  const { storage, persistence } = tokenStorage(file, cipher(false).cipher);
  await storage.set("ponzu.session", "new");
  expect(persistence()).toBe("memory");
  await storage.delete("ponzu.session");
  expect(() => statSync(file)).toThrow();
  expect(await tokenStorage(file, cipher().cipher).storage.get("ponzu.session")).toBeNull();
});
