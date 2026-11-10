// Postgres cannot hold U+0000 in text or json, and its json refuses half of a surrogate pair
// (what `text.slice(0, n)` leaves behind when it cuts an emoji). Either one fails the whole
// statement, so this package decides what happens to such text before it is sent.

// With the `u` flag a pair is one character, so the surrogate range matches only a lone half.
const UNSTORABLE = /[\u0000\uD800-\uDFFF]/u;
const EVERY_UNSTORABLE = /[\u0000\uD800-\uDFFF]/gu;

/**
 * The json text of `value`, or null when a string in it (a key counts) is one Postgres cannot
 * store. For content that must be stored exactly as it was sent, or not at all.
 */
export function toStorableJson(value: unknown): string | null {
  let storable = true;
  const text = JSON.stringify(value, (key, inner) => {
    if (UNSTORABLE.test(key) || (typeof inner === "string" && UNSTORABLE.test(inner))) {
      storable = false;
    }
    return inner;
  });
  return storable ? text : null;
}

/**
 * Whether Postgres can store every string in a json value. The API asks while it validates an
 * op, so one op with such text is rejected on its own and the rest of its batch goes on.
 */
export function isStorable(value: unknown): boolean {
  return toStorableJson(value) !== null;
}

/**
 * `value` with U+FFFD in place of whatever Postgres cannot store, for payloads where losing a
 * stray character beats losing the write: tool output, a message. The same value comes back
 * when there is nothing to replace.
 */
export function scrubbed<T>(value: T): T {
  if (isStorable(value)) return value;
  return JSON.parse(JSON.stringify(value, (_key, inner) => scrub(inner)));
}

const scrubText = (text: string) => text.replace(EVERY_UNSTORABLE, "\ufffd");

function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  // `JSON.stringify` goes on into what this returns, so the values are scrubbed in their turn.
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [scrubText(key), inner]));
}

/** What `createDesign` and `writeCheckpoint` throw for a document that cannot be stored. */
export function unstorableDocument(): Error {
  return new Error(
    "The document holds text Postgres cannot store: a NUL, or half of a surrogate pair.",
  );
}
