import type { Doc, Op } from "../doc.ts";
import { walk } from "../tree.ts";
import type { PElement } from "../types.ts";
import { el, text } from "./ops.ts";
import type { Random } from "./random.ts";

/**
 * A random op of any variant, aimed at what `doc` holds now. Most apply; some don't (a batch
 * whose second op needs what its first removed, a target that isn't there), as happens to a
 * real client too. `fresh` gives a string nobody else has, for new ids and for content.
 *
 * Some carry what the API won't take as it is: an `onclick`, a forged author, an id that
 * isn't one. Those are sanitized, stamped or rejected when committed.
 */
export function randomOp(r: Random, doc: Doc, fresh: () => string): Op {
  const boards = doc.pages.flatMap((p) => p.artboards);
  const all = boards.flatMap((a) => [...walk(a.root)]);
  const inner = all.filter((e) => e.parent);
  const some = <T>(items: T[]): T | undefined => (items.length ? r.pick(items) : undefined);

  const node = () => some(all)?.node.id ?? "n_none";
  const child = () => some(inner)?.node.id ?? "n_none";
  const board = () => some(boards)?.id ?? "ab_none";
  const page = () => some(doc.pages)?.id ?? "pg_none";
  const thread = () => some(doc.threads)?.id ?? "th_none";
  /** A thread and one of its messages. */
  const message = () => {
    const t = some(doc.threads);
    return { id: t?.id ?? "th_none", messageId: some(t?.messages ?? [])?.id ?? "m_none" };
  };
  const forged = { kind: "user" as const, name: "Forged", id: "user_forged" };

  const element = (): PElement => {
    const made = el(`n_${fresh()}`, r.pick(["div", "p", "span", "button"]), [text(fresh())]);
    made.style = { color: r.pick(["red", "blue"]), "--k": fresh() };
    if (r.chance(0.2)) made.attrs = { onclick: "steal()", class: fresh() };
    if (r.chance(0.2)) made.children.push(el(`n_${fresh()}`, r.pick(["b", "script", "iframe"])));
    return made;
  };

  const makers: (() => Op)[] = [
    () => ({ op: "insert", parent: node(), index: r.int(4), nodes: [element()] }),
    () => ({ op: "insert", parent: node(), index: r.int(4), nodes: [element(), text(fresh())] }),
    () => ({ op: "remove", id: child() }),
    () => ({ op: "move", id: child(), parent: node(), index: r.int(4) }),
    () => ({ op: "style", id: node(), style: { width: `${r.int(900)}px`, "--k": fresh() } }),
    () => ({ op: "style", id: node(), style: { background: "url(javascript:x)", "--k": fresh() } }),
    () => ({ op: "attrs", id: node(), attrs: { title: fresh(), onmouseover: "steal()" } }),
    () => ({ op: "name", id: node(), name: r.chance(0.2) ? null : fresh() }),
    () => ({ op: "children", id: child(), children: [text(fresh()), element()] }),
    () => {
      const id = `ab_${fresh()}`;
      const root = el(id, "section", [element()]);
      const artboard = { id, name: fresh(), x: r.int(4000), y: r.int(4000), root };
      return { op: "artboard.create", page: page(), index: r.int(3), artboard };
    },
    () => ({ op: "artboard.delete", id: board() }),
    () => ({ op: "artboard.update", id: board(), x: r.int(4000), y: r.int(4000) }),
    () => ({ op: "artboard.update", id: board(), name: fresh() }),
    () => ({ op: "artboard.move", id: board(), page: page(), index: r.int(3) }),
    () => ({ op: "page.create", index: r.int(4), page: { id: `pg_${fresh()}`, name: fresh() } }),
    () => ({ op: "page.create", index: 0, page: { id: `not an id ${fresh()}`, name: fresh() } }),
    () => ({ op: "page.delete", id: page() }),
    () => ({ op: "page.update", id: page(), name: fresh(), icon: r.chance(0.5) ? "star" : null }),
    () => ({ op: "page.order", ids: doc.pages.map((p) => p.id).reverse() }),
    () => ({ op: "page.move", id: page(), index: r.int(4) }),
    () => ({ op: "file.rename", name: fresh() }),
    () => ({ op: "file.icon", icon: r.chance(0.3) ? null : r.pick(["star", "cart", "phone"]) }),
    () => ({ op: "file.scratch", scratch: r.chance(0.5) }),
    () => ({ op: "tokens", css: `:root { --k: ${fresh()}; --bad: expression(${fresh()}) }` }),
    () => ({
      op: "thread.create",
      thread: {
        id: `th_${fresh()}`,
        ...(r.chance(0.5) ? { artboardId: board() } : { pageId: page() }),
        x: r.int(500),
        y: r.int(500),
        status: "open",
        createdAt: 1,
        updatedAt: 1,
        messages: [{ id: `m_${fresh()}`, author: forged, text: fresh(), createdAt: 1 }],
      },
    }),
    () => ({ op: "thread.delete", id: thread() }),
    () => ({
      op: "thread.update",
      id: thread(),
      status: r.pick(["open", "resolved"] as const),
      x: r.int(500),
      updatedAt: 1,
    }),
    () => ({ op: "thread.update", id: thread(), nodeId: r.chance(0.5) ? child() : null }),
    () => ({
      op: "thread.message",
      id: thread(),
      message: { id: `m_${fresh()}`, author: forged, text: fresh(), createdAt: 1 },
    }),
    () => ({ op: "thread.unmessage", ...message() }),
    () => ({ op: "thread.edit", ...message(), text: fresh(), editedAt: 1 }),
    () => ({
      op: "note",
      name: r.pick(["brief", "decisions"]),
      content: r.chance(0.2) ? null : fresh(),
    }),
  ];
  const one = (): Op => {
    const op = r.pick(makers)();
    // Deleting a page or an artboard takes most of a small canvas with it: make it rarer,
    // so there is something left for the other ops to aim at.
    const sweeping = op.op === "page.delete" || op.op === "artboard.delete";
    return sweeping && r.chance(0.7) ? r.pick(makers)() : op;
  };
  return r.chance(0.1) ? { op: "batch", ops: [one(), one()] } : one();
}
