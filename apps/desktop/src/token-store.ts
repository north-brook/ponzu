import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyValueStorage } from "@ponzu/client";
import type { SessionPersistence } from "./bridge.ts";

/*
 * Where the session's tokens are kept: one file, encrypted by Electron's `safeStorage` with a key
 * the operating system holds (the login keychain on a Mac, DPAPI on Windows, the Secret Service
 * on Linux). When there is no such key, nothing is written down: the tokens stay in memory and
 * the person is told they will have to sign in again next time.
 *
 * The keychain is asked only when there is something to read or write. On a Mac, asking whether
 * encryption is available already reads the key, which can mean a prompt; a launch with nobody
 * signed in never does.
 */

/** `safeStorage`, as much of it as this needs. */
export interface Cipher {
  /** False when the OS has no key to give, or (Linux's `basic_text`) only a key in the clear. */
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface TokenStorage {
  storage: KeyValueStorage;
  /** Where the tokens went, as far as anything has been written: the keychain until told otherwise. */
  persistence(): SessionPersistence;
}

export function tokenStorage(file: string, cipher: Cipher): TokenStorage {
  let memory: KeyValueStorage | null = null;
  const encrypted = encryptedFile(file, cipher);
  /** The keychain, once a write has found it there; memory from then on when it isn't. */
  const target = () => {
    if (!memory && !cipher.available()) memory = memoryStorage();
    return memory ?? encrypted;
  };
  return {
    storage: {
      get: (key) => (memory ?? encrypted).get(key),
      set: (key, value) => target().set(key, value),
      delete: (key) => (memory ?? encrypted).delete(key),
    },
    persistence: () => (memory ? "memory" : "keychain"),
  };
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
 * keychain was reset) holds nothing. No file is nothing, without asking the keychain.
 */
function encryptedFile(file: string, cipher: Cipher): KeyValueStorage {
  const read = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(cipher.decrypt(readFileSync(file))) as Record<string, string>;
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
      if (!existsSync(file)) return;
      const { [key]: _gone, ...rest } = read();
      write(rest);
    },
  };
}
