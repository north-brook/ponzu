import type { Op } from "./doc.ts";
import { cleanAttrs, cleanCss, cleanSheet, cleanShell, cleanStyle, isTextOnly } from "./rules.ts";
import type { Artboard, Dropped, PElement, PNode } from "./types.ts";

/**
 * A copy of a node tree with everything the rules forbid removed: blocked elements, `on*`
 * handlers, script URLs, script in CSS (see rules.ts). The same rules `parseHtml` applies to
 * HTML text, for trees that never were text. Null when the node itself can't stay.
 * `dropped` collects what was removed.
 *
 * Sanitizing twice changes nothing more, and it never reorders attributes or declarations.
 */
export function sanitizeNode(node: PNode, dropped: Dropped[] = []): PNode | null {
  if (node.kind === "text") return node;
  const shell = cleanShell(node, dropped);
  if (!shell) return null;
  const copy: PElement = { ...node, ...shell, children: [] };
  if (!shell.ns) delete copy.ns;
  copy.children = isTextOnly(shell.tag)
    ? textOf(node, shell.tag, dropped)
    : sanitizeNodes(node.children, dropped);
  return copy;
}

/**
 * What a text-only element keeps: its text, as the one node a parser would read it as. Joined
 * before it's checked, because that is how it's written out: script in CSS could otherwise
 * hide in the seam between two text nodes.
 */
function textOf(node: PElement, tag: string, dropped: Dropped[]): PNode[] {
  let value = "";
  for (const child of node.children) {
    if (child.kind === "text") value += child.value;
    else dropped.push({ what: `<${child.tag}> inside <${tag}>` });
  }
  if (tag.toLowerCase() === "style") value = cleanSheet(value, dropped);
  if (!value) return [];
  const only = node.children.length === 1 ? node.children[0]! : null;
  return only?.kind === "text" && only.value === value ? [only] : [{ kind: "text", value }];
}

export function sanitizeNodes(nodes: PNode[], dropped: Dropped[] = []): PNode[] {
  const out: PNode[] = [];
  for (const node of nodes) {
    const clean = sanitizeNode(node, dropped);
    if (clean) out.push(clean);
  }
  return out;
}

/**
 * A copy of an op with everything it carries sanitized: the nodes of `insert`, `children`
 * and `artboard.create`, the maps of `attrs` and `style`, the CSS of `tokens`, and the ops
 * of a `batch`. The other variants carry nothing to sanitize and come back as they are.
 *
 * It sees the op alone, not the design it lands in, so two rules that depend on where a node
 * ends up are the serializer's to keep instead (html.ts): a scene script stays data and a
 * text-only element writes only text, wherever an `insert` or a `move` puts them. Text that
 * an op puts into a `<style>` already in the design is not checked for script in CSS.
 */
export function sanitizeOp(op: Op, dropped: Dropped[] = []): Op {
  switch (op.op) {
    case "insert":
      return { ...op, nodes: sanitizeNodes(op.nodes, dropped) };
    case "children":
      return { ...op, children: sanitizeNodes(op.children, dropped) };
    case "attrs":
      return { ...op, attrs: cleanAttrs(op.attrs, dropped) };
    case "style":
      return { ...op, style: cleanStyle(op.style, dropped) };
    case "artboard.create":
      return { ...op, artboard: { ...op.artboard, root: sanitizeRoot(op.artboard, dropped) } };
    case "tokens": {
      const css = cleanCss(op.css);
      if (css !== op.css) dropped.push({ what: "script in the tokens" });
      return { ...op, css };
    }
    case "batch":
      return { ...op, ops: op.ops.map((child) => sanitizeOp(child, dropped)) };
    case "remove":
    case "move":
    case "name":
    case "artboard.delete":
    case "artboard.update":
    case "artboard.move":
    case "page.create":
    case "page.delete":
    case "page.update":
    case "page.order":
    case "page.move":
    case "file.rename":
    case "file.icon":
    case "file.scratch":
    case "thread.create":
    case "thread.delete":
    case "thread.update":
    case "thread.message":
    case "thread.unmessage":
    case "thread.edit":
    case "note":
      return op;
    default: {
      // Every variant is named above, so a new one doesn't compile until someone has decided
      // whether it carries anything to sanitize.
      const undecided: never = op;
      return undecided;
    }
  }
}

/** An artboard always has a root, so one that can't stay becomes an empty frame of its size. */
function sanitizeRoot(artboard: Artboard, dropped: Dropped[]): PElement {
  const root = sanitizeNode(artboard.root, dropped);
  if (root?.kind === "el" && root.tag !== "script") return root;
  if (root) dropped.push({ what: "<script> as an artboard" });
  const { ns: _, ...rest } = artboard.root;
  const style = cleanStyle(artboard.root.style, []);
  return { ...rest, tag: "section", attrs: {}, style, children: [] };
}
