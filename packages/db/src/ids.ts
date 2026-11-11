// Crockford's base 32, lowercase: no i, l, o or u, so an id reads back unambiguously.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export type IdPrefix =
  | "usr"
  | "ws"
  | "repo"
  | "cla"
  | "des"
  | "ti"
  | "evt"
  | "q"
  | "sbx"
  | "rt"
  | "rnr"
  | "up"
  | "dev"
  | "use"
  | "led"
  | "job"
  | "auth";

/** A primary key like `des_7k2m9x4q0c8v5n1t`: what the row is, then 80 random bits. */
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

/** `length` random characters, five bits each. */
export function randomString(length: number): string {
  let out = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) out += ALPHABET[byte & 31];
  return out;
}
