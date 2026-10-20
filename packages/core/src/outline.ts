import type { Doc } from "./doc.ts";
import { describeNode, elementChildren, visibleText } from "./tree.ts";
import type { Artboard, PElement } from "./types.ts";

/**
 * Compact indented outline of an element tree, for agents. One line per
 * element: tag, id, name or text, and the few styles that matter for layout.
 */
export function outline(root: PElement, maxDepth = 4): string {
  const lines: string[] = [];
  const visit = (el: PElement, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${line(el)}`);
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

function line(el: PElement): string {
  const parts = [`<${el.tag}>`, el.id];
  if (el.name) parts.push(`"${el.name}"`);
  const kids = elementChildren(el);
  const text = visibleText(el);
  if (text && kids.length === 0)
    parts.push(`text="${text.length > 60 ? `${text.slice(0, 60)}…` : text}"`);
  const s = el.style;
  const layout: string[] = [];
  if (s.display && s.display !== "block")
    layout.push(s.display === "flex" ? `flex ${s["flex-direction"] ?? "row"}` : s.display);
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

/** One-screen overview of a whole file: pages, artboards, open threads. */
export function docSummary(doc: Doc): string {
  const lines = [`File: ${doc.name}`];
  for (const page of doc.pages) {
    lines.push(`Page ${page.id} "${page.name}"${page.artboards.length ? "" : " (empty)"}`);
    for (const ab of page.artboards) lines.push(`  ${artboardSummary(ab)}`);
  }
  const open = doc.threads.filter((t) => t.status === "open");
  if (open.length) lines.push(`Open comment threads: ${open.length} (list_comments)`);
  const notes = Object.keys(doc.notes);
  if (notes.length) lines.push(`Notes: ${notes.join(", ")} (read_notes)`);
  return lines.join("\n");
}

export { describeNode };
