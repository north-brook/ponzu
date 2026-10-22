import type { Doc } from "./doc.ts";
import { describeNode, elementChildren, visibleText } from "./tree.ts";
import type { Artboard, PElement } from "./types.ts";

/**
 * An artboard root that sets display: flex but no direction. Artboards are
 * flex columns, so it stays one, while HTML written for plain CSS expects a
 * row there.
 */
export function rootDirectionUnset(style: Record<string, string>): boolean {
  return (
    /^(inline-)?flex$/.test(style.display ?? "") && !style["flex-direction"] && !style["flex-flow"]
  );
}

export const ROOT_DIRECTION_NOTE =
  "sets display: flex with no flex-direction, so it stays a column (the artboard default; plain CSS would make it a row). Set flex-direction: row for side-by-side panes, or column to keep it";

/**
 * Compact indented outline of an element tree, for agents. One line per
 * element: tag, id, name or text, and the few styles that matter for layout.
 * With `artboard`, the root is an artboard and shows the flex column it
 * renders as.
 */
export function outline(root: PElement, maxDepth = 4, opts: { artboard?: boolean } = {}): string {
  const lines: string[] = [];
  const visit = (el: PElement, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${line(el, depth === 0 && !!opts.artboard)}`);
    const kids = elementChildren(el);
    if (depth >= maxDepth) {
      if (kids.length)
        lines.push(`${"  ".repeat(depth + 1)}… ${kids.length} more (get_tree id=${el.id})`);
      return;
    }
    for (const c of kids) visit(c, depth + 1);
  };
  visit(root, 0);
  return lines.join("\n");
}

function line(el: PElement, artboard: boolean): string {
  const parts = [`<${el.tag}>`, el.id];
  if (el.name) parts.push(`"${el.name}"`);
  const kids = elementChildren(el);
  const text = visibleText(el);
  if (text && kids.length === 0)
    parts.push(`text="${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`);
  const s = el.style;
  const layout: string[] = [];
  const display = s.display ?? (artboard ? "flex" : undefined);
  if (display && display !== "block") {
    // flex-flow sets the direction too, to row when it only names a wrap.
    const flow =
      s["flex-flow"] && (/\b(row|column)(-reverse)?\b/.exec(s["flex-flow"])?.[0] ?? "row");
    const direction = s["flex-direction"] ?? flow ?? (artboard ? "column" : "row");
    layout.push(/^(inline-)?flex$/.test(display) ? `${display} ${direction}` : display);
  }
  if (s.width) layout.push(`w=${s.width}`);
  if (s.height) layout.push(`h=${s.height}`);
  if (s.position === "absolute") layout.push("abs");
  if (layout.length) parts.push(`[${layout.join(" ")}]`);
  return parts.join(" ");
}

export function artboardSummary(ab: Artboard): string {
  const w = ab.root.style.width ?? "auto";
  const h = ab.root.style.height ?? "auto";
  return `${ab.id} "${ab.name}" ${w}×${h} at (${ab.x}, ${ab.y})`;
}

/**
 * One-screen overview of a whole file: pages, artboards, open threads.
 * `folderOf` adds where each page's files live.
 */
export function docSummary(
  doc: Doc,
  opts: { folderOf?: (pageId: string) => string | undefined } = {},
): string {
  const lines = [`File: ${doc.name}`];
  for (const page of doc.pages) {
    const folder = opts.folderOf?.(page.id);
    lines.push(
      `Page ${page.id} "${page.name}"${folder ? ` · ${folder}` : ""}${page.artboards.length ? "" : " (empty)"}`,
    );
    for (const ab of page.artboards) lines.push(`  ${artboardSummary(ab)}`);
  }
  const open = doc.threads.filter((t) => t.status === "open");
  if (open.length) lines.push(`Open comment threads: ${open.length} (list_comments)`);
  const notes = Object.keys(doc.notes);
  if (notes.length) lines.push(`Notes: ${notes.join(", ")} (read_notes)`);
  return lines.join("\n");
}

export { describeNode };
