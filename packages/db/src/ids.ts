// Crockford's base 32, lowercase: no i, l, o or u, so an id reads back unambiguously.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type IdPrefix =
  | "usr"
  | "ws"
  | "repo"
  | "cla"
  | "cnv"
  | "ti"
  | "evt"
  | "q"
  | "sbx"
  | "rt"
  | "rnr"
  | "clm"
  | "up"
  | "dev"
  | "use"
  | "led"
  | "job"
  | "auth"
  | "ntf"
  | "ndl";

/** A primary key like `cnv_7k2m9x4q0c8v5n1t`: what the row is, then 80 random bits. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomString(16)}`;
}

/**
 * Whether `value` is an id as `newId(prefix)` makes them: the prefix and 16 characters of the
 * alphabet. For ids a caller chose (a runner's thread items and questions), checked before they
 * reach a row.
 */
export function isId(prefix: IdPrefix, value: string): boolean {
  return (
    value.length === prefix.length + 17 &&
    value.startsWith(`${prefix}_`) &&
    ID_TAIL.test(value.slice(prefix.length + 1))
  );
}

const ID_TAIL = new RegExp(`^[${ALPHABET}]{16}$`);

/** How long a canvas's asset key is: 160 random bits, all that guards the canvas's files. */
export const ASSET_KEY_LENGTH = 32;

/** A new asset key: the first segment of every object key under a canvas's files. */
export function newAssetKey(): string {
  return randomString(ASSET_KEY_LENGTH);
}

/**
 * Whether `value` is an asset key as `newAssetKey` makes them, and nothing more: the guard on
 * anything that deletes a canvas's files by prefix.
 */
export function isAssetKey(value: string): boolean {
  return ASSET_KEY.test(value);
}

const ASSET_KEY = new RegExp(`^[${ALPHABET}]{${ASSET_KEY_LENGTH}}$`);

/** `length` random characters, five bits each. */
export function randomString(length: number): string {
  let out = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) out += ALPHABET[byte & 31];
  return out;
}
