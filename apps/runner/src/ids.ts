import { createHash, randomBytes } from "node:crypto";

// The API's ids: a prefix, then 16 characters of Crockford's base 32 (packages/db/src/ids.ts).
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function encode(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes.subarray(0, 16)) out += ALPHABET[byte & 31];
  return out;
}

/** A new id the runner chooses, like `ti_7k2m9x4q0c8v5n1t`. */
export function randomId(prefix: string): string {
  return `${prefix}_${encode(randomBytes(16))}`;
}

/** The same id every time for the same seed: a question for a tool call, after a restart too. */
export function derivedId(prefix: string, seed: string): string {
  return `${prefix}_${encode(createHash("sha256").update(seed).digest())}`;
}

/**
 * The uuid an event's message goes into the Claude session under. It is the event's own, so
 * the session's transcript says which events it holds when the runner starts again.
 */
export function eventUuid(eventId: string): string {
  const h = createHash("sha256").update(`ponzu-event:${eventId}`).digest("hex");
  // A version 8 (custom) uuid, RFC 9562: the version nibble 8, the variant bits 10.
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
