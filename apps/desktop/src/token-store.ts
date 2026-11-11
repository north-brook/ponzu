import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyValueStorage } from "@ponzu/client";
import type { SessionPersistence } from "./bridge.ts";

/*
 * Where the session's tokens are kept: one file, encrypted by Electron's `safeStorage` with a key
 * the operating system holds (the login keychain on a Mac, DPAPI on Windows, the Secret Service
 * on Linux). When there is no such key, nothing is written down: the tokens stay in memory and
 * the person is told they will have to sign in again next time.
 */

/** `safeStorage`, as much of it as this needs. */
export interface Cipher {
  /** False when the OS has no key to give, or (Linux's `basic_text`) only a key in the clear. */
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export function tokenStorage(
  file: string,
  cipher: Cipher,
): { storage: KeyValueStorage; persistence: SessionPersistence } {
  if (!cipher.available()) return { storage: memoryStorage(), persistence: "memory" };
  return { storage: encryptedFile(file, cipher), persistence: "keychain" };
}

export function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
}

/**
 * Every key in one encrypted file, rewritten whole through a file beside it, so a crash leaves
 * the old pair or the new one and never half of either. A file that can't be decrypted (the
 * keychain was reset) holds nothing.
 */
function encryptedFile(file: string, cipher: Cipher): KeyValueStorage {
  const read = (): Record<string, string> => {
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch {
      return {};
    }
    try {
      return JSON.parse(cipher.decrypt(data)) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = (values: Record<string, string>) => {
    if (!Object.keys(values).length) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, cipher.encrypt(JSON.stringify(values)), { mode: 0o600 });
    renameSync(temporary, file);
  };
  return {
    get: async (key) => read()[key] ?? null,
    set: async (key, value) => write({ ...read(), [key]: value }),
    delete: async (key) => {
      const { [key]: _gone, ...rest } = read();
      write(rest);
    },
  };
}
