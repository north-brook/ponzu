/*
 * A design's branch, `pz/<topic>` (docs/cloud.md, "The sandbox"): chosen once, when the design is
 * created, from what its first message is about, and never renamed. The topic is the message's
 * first few words that say something, so a person can tell their pull requests apart by
 * branch: "Make the pricing page calmer, with a quieter hero" is `pz/pricing-page-calmer`.
 * No model is asked: it is a slug, not a summary, and it is there at once.
 */

/** Words that say nothing about what a design is for. */
const FILLER = new Set(
  (
    "a an the and or but of to for in on at by with from into onto as is are be been being it its " +
    "this that these those there here my our your their his her me we you i us them " +
    "please can could would should will let lets make made create design add build do try give " +
    "new some more less very really just like want need get put use show draw redo update change " +
    "up out about over so too also then than what how which who"
  ).split(" "),
);
const MAX_WORDS = 3;
const MAX_LENGTH = 40;
/** Where a design about nothing in particular goes. */
const FALLBACK = "design";

/** The topic of `text` as a slug: lowercase ASCII words joined by dashes. */
export function branchTopic(text: string): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !FILLER.has(word));
  let topic = "";
  for (const word of words.slice(0, MAX_WORDS)) {
    const next = topic ? `${topic}-${word}` : word;
    if (next.length > MAX_LENGTH) break;
    topic = next;
  }
  return topic || FALLBACK;
}

/** `pz/<topic>`, or with the first number after it that none of `taken` has. */
export function branchFor(topic: string, taken: readonly string[]): string {
  const base = `pz/${topic}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
