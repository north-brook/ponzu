import type { ThreadItem } from "../cloud/model.ts";
import { keepUnchanged } from "./map.ts";

/*
 * The thread's lines as the rail draws them, each one made again only when what it is made from
 * has changed, and kept as the same object when it comes out the same. A line (ThreadLine) is
 * drawn again only when its item is a new object, so a comment, a reply, a resolve or an
 * agent's commit draws the lines it changed and no others.
 */

/** One line to make: its id, everything it is made from, and how to make it. */
export interface LineSource {
  id: string;
  /** Compared one by one with what it was made from last time (Object.is). */
  from: readonly unknown[];
  make: () => ThreadItem;
}

export interface Lines {
  items: ThreadItem[];
  made: ReadonlyMap<string, { from: readonly unknown[]; item: ThreadItem }>;
}

export function keepLines(before: Lines | null, sources: readonly LineSource[]): Lines {
  const made = new Map<string, { from: readonly unknown[]; item: ThreadItem }>();
  const items = sources.map(({ id, from, make }) => {
    const was = before?.made.get(id);
    const item = !was
      ? make()
      : sameInputs(was.from, from)
        ? was.item
        : keepUnchanged(was.item, make());
    made.set(id, { from, item });
    return item;
  });
  return { items: keepUnchanged(before?.items ?? [], items), made };
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}
