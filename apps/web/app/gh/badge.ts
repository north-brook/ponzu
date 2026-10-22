import { SLICE, SLICE_STROKE } from "@ponzu/react/slice";

/*
 * The README badge, drawn the way shields.io draws its own so it sits in a row of them: 20px
 * tall, 3px corners, Verdana 11. The label half is plain ink, like every other shield's; the
 * message half is the brand: yuzu, the ink slice, then "Ponzu". The label is a design's name ("Kettle | Ponzu"), or "open in" for a
 * badge linking to a repo's designs.
 */

/** Verdana 11px advance widths, from shields' own table, for the characters badges use. */
const WIDE = /[MW@%]/;
const NARROW = /[ijlI!.,:;'|]/;
/** Verdana's slim lowercase: about 4.3–4.7px at 11px. */
const SLIM = /[tfr]/;
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (NARROW.test(ch)) w += 3.5;
    else if (SLIM.test(ch)) w += 4.5;
    else if (ch === " ") w += 3.9;
    else if (WIDE.test(ch)) w += 10.5;
    else if (ch >= "A" && ch <= "Z") w += 7.5;
    else if (ch >= "0" && ch <= "9") w += 7;
    else w += 6.6;
  }
  return Math.ceil(w);
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** A label fit for a badge: trimmed, one line, at most 40 characters. */
export function badgeLabel(raw: string | null): string {
  const label = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return label || "open in";
}

export function badgeSvg(label: string): string {
  const icon = 12;
  const left = 6 + textWidth(label) + 6;
  const message = "Ponzu";
  const right = 5 + icon + 4 + textWidth(message) + 6;
  const width = left + right;
  const slice = SLICE.map((d) => `<path d="${d}"/>`).join("");
  const title = xml(`${label} | Ponzu`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" role="img" aria-label="${title}"><title>${title}</title><clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${left}" height="20" fill="#1c1c1c"/><rect x="${left}" width="${right}" height="20" fill="#ffc81e"/></g><g transform="translate(${left + 5} 4) scale(${icon / 64})" fill="#111110" stroke="#111110" stroke-width="${SLICE_STROKE}" stroke-linejoin="round">${slice}</g><g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="6" y="15" fill="#010101" fill-opacity=".3">${xml(label)}</text><text x="6" y="14" fill="#fff">${xml(label)}</text><text x="${left + 5 + icon + 4}" y="14" fill="#111110">${message}</text></g></svg>`;
}
