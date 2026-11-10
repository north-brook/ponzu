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
  | "dev"
  | "use"
  | "led"
  | "job"
  | "auth";

/** A primary key like `des_7k2m9x4q0c8v5n1t`: what the row is, then 80 random bits. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomString(16)}`;
}

/** `length` random characters, five bits each. */
export function randomString(length: number): string {
  let out = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) out += ALPHABET[byte & 31];
  return out;
}
