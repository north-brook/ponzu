/**
 * Class names a shadcn/ui component arrives with that paint nothing in the cloud build (or paint
 * the wrong thing): cloud.css clears Tailwind's palette, radii, shadows and type scale, and one
 * of shadcn's semantic names (`muted`) is already ours with another meaning (`secondary` is ours
 * too, and means the same: a ground). Each maps onto our tokens by hand, as src/cloud/README.md
 * lists; `bun run shadcn` and `shadcn-names.test.ts` point out any that are left.
 */
const SEMANTIC =
  "background|foreground|card|card-foreground|popover|popover-foreground|primary|primary-foreground|secondary-foreground|muted-foreground|accent|accent-foreground|destructive|destructive-foreground|border|input|ring|sidebar[a-z-]*|chart-[0-9]";

export const UNMAPPED = new RegExp(
  [
    // shadcn's semantic colors, after any variant (`hover:`, `data-[state=open]:`) and with any
    // opacity (`/50`).
    `(?<![\\w-])(?:bg|text|border|ring|ring-offset|outline|fill|stroke|from|to|via|divide|placeholder|caret|decoration)-(?:${SEMANTIC})(?:/\\d+)?(?![\\w-])`,
    // `bg-muted`: a ground in shadcn, a text color here.
    "(?<![\\w-])bg-(?:muted)(?:/\\d+)?(?![\\w-])",
    // Tailwind's own scales, cleared in cloud.css.
    "(?<![\\w-])rounded(?:-[trblse]{1,2})?-(?:xs|sm|md|lg|xl|2xl|3xl|4xl)(?![\\w-])",
    "(?<![\\w-])shadow-(?:2xs|xs|sm|md|lg|xl|2xl)(?![\\w-])",
    "(?<![\\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\\w-])",
    // Palette colors.
    "(?<![\\w-])(?:bg|text|border|ring|fill|stroke)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3})(?:/\\d+)?(?![\\w-])",
    // tw-animate-css, which the cloud build doesn't load: our `pop` and `tip` animate instead.
    "(?<![\\w-])(?:animate-(?:in|out|pulse|spin)|fade-(?:in|out)-\\d+|zoom-(?:in|out)-\\d+|slide-(?:in|out)-from-[a-z]+-\\d+)(?![\\w-])",
    // A ring or border width for focus: keyboard focus is `focus-ring`.
    "(?<![\\w-])ring-\\[\\d+px\\](?![\\w-])",
  ].join("|"),
  "g",
);

/** Every unmapped class in a source file, with its line. */
export function unmappedClasses(source: string): { line: number; name: string }[] {
  const found: { line: number; name: string }[] = [];
  source.split("\n").forEach((text, i) => {
    for (const match of text.matchAll(UNMAPPED)) found.push({ line: i + 1, name: match[0] });
  });
  return found;
}
