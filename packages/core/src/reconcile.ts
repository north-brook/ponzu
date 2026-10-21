import { serializeNode } from "./html.ts";
import { newId } from "./ids.ts";
import { elementChildren, walk } from "./tree.ts";
import type { PElement } from "./types.ts";

/**
 * Carry ids from `prev` to `next`, a fresh parse of the same artboard after
 * someone edited its file. `derived` holds the ids the parser made up from
 * position, for elements the file gave no data-id. Only those change.
 *
 * An element keeps its id while it stays the same: unchanged, it keeps it
 * wherever it moved; edited, it keeps it while it is the same tag in the
 * same parent. Ids written in the file always win, and an element that
 * matches nothing keeps its positional id unless an older element holds it.
 *
 * Returns true when an id no longer matches its position, so the file must
 * spell the ids out to keep them across a reload.
 */
export function carryIds(prev: PElement, next: PElement, derived: Set<string>): boolean {
  const lazy = new Set<PElement>();
  const taken = new Set<string>();
  for (const { node } of walk(next)) {
    if (derived.has(node.id)) lazy.add(node);
    else taken.add(node.id);
  }
  if (!lazy.size) return false;

  const shapes = new WeakMap<PElement, string>();
  const shape = (el: PElement) => {
    let s = shapes.get(el);
    if (s === undefined) {
      s = serializeNode(el, { omitIds: true });
      shapes.set(el, s);
    }
    return s;
  };
  const oldDone = new Set<PElement>();
  const newDone = new Set<PElement>();
  const kept = new Set<PElement>();
  let changed = false;

  const pair = (o: PElement, n: PElement) => {
    oldDone.add(o);
    newDone.add(n);
    if (!lazy.has(n) || taken.has(o.id)) return;
    if (n.id !== o.id) changed = true;
    n.id = o.id;
    taken.add(o.id);
    kept.add(n);
  };

  const match = (o: PElement, n: PElement) => {
    pair(o, n);
    const olds = elementChildren(o).filter((c) => !oldDone.has(c));
    const pairs: [PElement, PElement][] = [];
    const claimed = new Set<PElement>();
    const claim = (a: PElement, b: PElement) => {
      claimed.add(a);
      pairs.push([a, b]);
    };
    let news = elementChildren(n).filter((c) => !newDone.has(c));
    // 1. Ids written in the file.
    const byId = new Map(olds.map((c) => [c.id, c]));
    news = news.filter((c) => {
      const hit = !lazy.has(c) && byId.get(c.id);
      if (hit) claim(hit, c);
      return !hit;
    });
    // 2. Unchanged elements, wherever they moved among their siblings.
    const byShape = new Map<string, PElement[]>();
    for (const c of olds) {
      if (claimed.has(c)) continue;
      const list = byShape.get(shape(c));
      if (list) list.push(c);
      else byShape.set(shape(c), [c]);
    }
    news = news.filter((c) => {
      const hit = byShape.get(shape(c))?.find((x) => !claimed.has(x));
      if (hit) claim(hit, c);
      return !hit;
    });
    // 3. Edited elements: the next unclaimed sibling with the same tag, in order.
    let from = 0;
    for (const c of news) {
      for (let i = from; i < olds.length; i++) {
        const hit = olds[i]!;
        if (claimed.has(hit) || hit.tag !== c.tag) continue;
        claim(hit, c);
        from = i + 1;
        break;
      }
    }
    for (const [a, b] of pairs) match(a, b);
  };
  match(prev, next);

  // Unchanged elements that moved to another parent, when they're unambiguous.
  const unique = new Map<string, PElement | null>();
  for (const { node } of walk(prev)) {
    if (oldDone.has(node)) continue;
    const s = shape(node);
    unique.set(s, unique.has(s) ? null : node);
  }
  for (const { node } of walk(next)) {
    if (newDone.has(node) || !lazy.has(node)) continue;
    const hit = unique.get(shape(node));
    if (hit && !oldDone.has(hit)) match(hit, node);
  }

  // Whatever matched nothing keeps its positional id, unless that's now taken.
  for (const node of lazy) {
    if (kept.has(node)) continue;
    if (taken.has(node.id)) {
      node.id = newId("n");
      changed = true;
    }
    taken.add(node.id);
  }
  return changed;
}
