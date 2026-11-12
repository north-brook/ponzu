/*
 * Starting a canvas from one prompt, as the Mac's create page and the phone's New canvas both
 * do: what the canvas is called until the agent names it, and when a prompt can go.
 */

/** The most a first name runs to, before it is cut at a word. */
const NAME_MAX = 40;

/**
 * What a canvas is called until the agent names it: what the first line of the prompt is about,
 * as a title. Its first clause, without the request's verb and article ("Design a pricing card:
 * a heading…" is "Pricing card"), cut at a word when it is still long.
 */
export function nameFor(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.trim();
  const clause = line.split(/(?<=[.!?])\s|[:;]\s|\s[—–-]\s/)[0]!.replace(/[\s.!?:;,]+$/, "");
  const topic = clause
    .replace(
      /^(?:(?:please|can you|could you)\s+)?(?:design|make|create|build|draw|mock up|sketch|redesign|add)\s+(?:me\s+|us\s+)?/i,
      "",
    )
    .replace(/^(?:a|an|the|some)\s+/i, "")
    .trim();
  const name = topic || line;
  const cut =
    name.length <= NAME_MAX
      ? name
      : `${name.slice(0, name.lastIndexOf(" ", NAME_MAX) > 12 ? name.lastIndexOf(" ", NAME_MAX) : NAME_MAX).replace(/[\s,;:]+$/, "")}…`;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/** The API's rule for a create key: 8 to 64 of `A-Za-z0-9_-`. */
export const CREATE_KEY = /^[A-Za-z0-9_-]{8,64}$/;
