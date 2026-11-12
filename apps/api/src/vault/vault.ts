/*
 * Encryption for the secrets the database keeps: GitHub user tokens now, Claude credentials
 * and repo secrets later. The key exists only in the API's environment, so a copy of the
 * database alone opens nothing.
 *
 * A sealed value is text:
 *
 *   pzv1.<key id>.<nonce>.<ciphertext and tag>
 *
 * `pzv1` is the format (AES-256-GCM, a 96-bit random nonce, base64url parts). The key id says
 * which key sealed it, so the key can be rotated: the new key seals, and the old ones stay
 * around to open what they sealed until it has been sealed again.
 *
 * Every value is bound to the place it is stored. The binding is authenticated with the
 * ciphertext, so a value copied into another row, or into another column of its own row, does
 * not open.
 */

const FORMAT = "pzv1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/** Where a sealed value lives. Opening it anywhere else fails. */
export interface Binding {
  /** The column, as `table.column`. */
  column: string;
  /** The row's key: a user id for a user's token, `<repo id>/<name>` for a repo secret. */
  row: string;
}

export interface Vault {
  seal(plaintext: string, binding: Binding): Promise<string>;
  /** Throws a `VaultError` if the value was altered, moved, or sealed with a key not held. */
  open(sealed: string, binding: Binding): Promise<string>;
  /** The id of the key that seals now (`PONZU_VAULT_KEY`'s): safe to store and to log. */
  currentKeyId(): Promise<string>;
}

/** The id of the key a sealed value was sealed with, or null when it is not in the format. */
export function keyIdOf(sealed: string): string | null {
  const [format, keyId] = sealed.split(".");
  return format === FORMAT && keyId ? keyId : null;
}

/** A sealed value that cannot be opened, or a key that cannot be used. It never quotes either. */
export class VaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaultError";
  }
}

interface HeldKey {
  id: string;
  key: CryptoKey;
}

/**
 * `key` seals; `key` and `oldKeys` open. Each is 32 random bytes in base64url, and a malformed
 * one throws here, when the API starts. A key's id is the start of its SHA-256, so the id
 * cannot be configured wrongly and is safe to store.
 */
export function createVault({ key, oldKeys = [] }: { key: string; oldKeys?: string[] }): Vault {
  const held = Promise.all([key, ...oldKeys].map(keyBytes).map(hold));

  return {
    async seal(plaintext, binding) {
      const current = (await held)[0]!;
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: additionalData(current.id, binding) },
        current.key,
        new TextEncoder().encode(plaintext),
      );
      return [FORMAT, current.id, encode(nonce), encode(new Uint8Array(ciphertext))].join(".");
    },

    async open(sealed, binding) {
      const [format, keyId, nonce, ciphertext, ...rest] = sealed.split(".");
      if (format !== FORMAT || !keyId || !nonce || !ciphertext || rest.length > 0) {
        throw new VaultError("The stored value is not in the vault's format.");
      }
      const holder = (await held).find(({ id }) => id === keyId);
      if (!holder) {
        throw new VaultError(`The stored value was sealed with a key (${keyId}) not held.`);
      }
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(nonce), additionalData: additionalData(keyId, binding) },
          holder.key,
          decode(ciphertext),
        );
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch (cause) {
        throw new VaultError(
          `The stored value does not open as ${binding.column}: it was altered or belongs elsewhere.`,
          { cause },
        );
      }
    },

    async currentKeyId() {
      return (await held)[0]!.id;
    },
  };
}

/** A fresh key, as `PONZU_VAULT_KEY` wants it. */
export function generateVaultKey(): string {
  return encode(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

function keyBytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = decode(text);
  if (bytes.length !== KEY_BYTES) {
    throw new VaultError("A vault key must be 32 bytes in base64url.");
  }
  return bytes;
}

async function hold(bytes: Uint8Array<ArrayBuffer>): Promise<HeldKey> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = Buffer.from(digest.subarray(0, 4)).toString("hex");
  const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id, key };
}

/** Unambiguous whatever the parts contain, because JSON quotes them. */
function additionalData(keyId: string, { column, row }: Binding): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify([FORMAT, keyId, column, row]));
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  // Buffer skips what it cannot read, which would let an altered value through as a shorter one.
  if (!/^[\w-]+$/.test(text)) throw new VaultError("A vault value is not base64url.");
  return new Uint8Array(Buffer.from(text, "base64url"));
}
