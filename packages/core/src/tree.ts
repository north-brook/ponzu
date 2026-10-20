import { newId } from "./ids.ts";
import type { PElement, PNode } from "./types.ts";

export interface Located {
  node: PElement;
  parent: PElement | null;
  index: number;
  depth: number;
}

/** Depth-first search from `root`, including root itself. */
export function findNode(root: PElement, id: string): Located | null {
  if (root.id === id) return { node: root, parent: null, index: 0, depth: 0 };
  const stack: { el: PElement; depth: number }[] = [{ el: root, depth: 0 }];
  while (stack.length) {
    const { el, depth } = stack.pop()!;
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i]!;
      if (c.kind !== "el") continue;
      if (c.id === id) return { node: c, parent: el, index: i, depth: depth + 1 };
      stack.push({ el: c, depth: depth + 1 });
    }
  }
  return null;
}

export function* walk(
  root: PElement,
  depth = 0,
): Generator<{ node: PElement; depth: number; parent: PElement | null }> {
  yield { node: root, depth, parent: null };
  yield* walkChildren(root, depth);
}

function* walkChildren(
  el: PElement,
  depth: number,
): Generator<{ node: PElement; depth: number; parent: PElement | null }> {
  for (const c of el.children) {
    if (c.kind !== "el") continue;
    yield { node: c, depth: depth + 1, parent: el };
    yield* walkChildren(c, depth + 1);
  }
}

export function textContent(node: PNode): string {
  if (node.kind === "text") return node.value;
  return node.children.map(textContent).join("");
}

/** Collapse whitespace the way a browser lays out normal text. */
export function visibleText(node: PNode): string {
  return textContent(node).replace(/\s+/g, " ").trim();
}

export function elementChildren(el: PElement): PElement[] {
  return el.children.filter((c): c is PElement => c.kind === "el");
}

/** Index among element children → index in children (text nodes included). */
export function rawIndex(parent: PElement, elementIndex: number): number {
  let seen = 0;
  for (let i = 0; i < parent.children.length; i++) {
    if (parent.children[i]!.kind !== "el") continue;
    if (seen === elementIndex) return i;
    seen++;
  }
  return parent.children.length;
}

export function cloneNode<T extends PNode>(node: T): T {
  return structuredClone(node);
}

/** Deep clone with fresh ids. `map` receives old id → new id. */
export function cloneWithNewIds(
  node: PElement,
  map: Record<string, string> = {},
  rootPrefix: "n" | "ab" = "n",
): PElement {
  const copy = structuredClone(node);
  for (const { node: n, depth } of walk(copy)) {
    const fresh = newId(depth === 0 ? rootPrefix : "n");
    map[n.id] = fresh;
    n.id = fresh;
  }
  return copy;
}

export function isAncestor(root: PElement, ancestorId: string, nodeId: string): boolean {
  const a = findNode(root, ancestorId);
  if (!a) return false;
  return findNode(a.node, nodeId) !== null;
}

/** A short label for a node: its name, or tag plus the start of its text. */
export function describeNode(n: PElement): string {
  if (n.name) return n.name;
  const text = visibleText(n);
  if (text) return text.length > 24 ? `${text.slice(0, 24)}…` : text;
  return n.tag;
}

/** Whether a node directly holds text (as opposed to only element children). */
export function isTextLike(n: PElement): boolean {
  return n.children.length > 0 && n.children.every((c) => c.kind === "text");
}
