import { type AgentChange, type Doc, findArtboard, type Op, type Presence } from "@ponzu/core";
import type { OpEvent } from "@ponzu/store";
import type { CatalogDb } from "./catalog-db.ts";
import { summarize } from "./workspace.ts";

/** Edits by one agent in one design this close together are one change. */
export const CHANGE_GAP = 2 * 60_000;
/** Changes kept per design, in memory and in the database. */
export const CHANGES_KEPT = 200;

/** A change while it can still grow: which of its artboards it made, and which it deleted. */
interface Run {
  change: AgentChange;
  added: Set<string>;
  removed: Set<string>;
}

/**
 * What agents changed in this Mac's designs, for the phone's Activity
 * ("Claude changed 12 artboards"). Each agent edit that touches artboards
 * joins the last change in its design when the same agent made that one
 * within a couple of minutes, and starts a new one otherwise. Kept in memory
 * and in the catalog database, so a restart doesn't empty the phone's
 * Activity, and every Ponzu on the Mac shares one history.
 */
export class ChangeLog {
  /** Each design's recent changes, oldest first. */
  private recent = new Map<string, AgentChange[]>();
  /** Each agent's latest change in each design, while it can still grow. */
  private runs = new Map<string, Run>();

  constructor(
    private db: CatalogDb,
    private presence: () => Presence[],
    private now: () => number = Date.now,
  ) {}

  /** An op applied to the design at `key`. Only an agent's edits to artboards count. */
  record(key: string, doc: Doc, e: OpEvent): AgentChange | null {
    if (e.origin.kind !== "agent" || !e.artboards.length) return null;
    const at = this.now();
    const name = e.origin.name;
    // Keyed by design and agent: another agent editing the same design in between
    // doesn't split this one's run.
    const slot = `${key}\0${name}`;
    let run = this.runs.get(slot);
    if (!run || at - run.change.at > CHANGE_GAP) {
      run = {
        change: {
          id: `ch_${crypto.randomUUID().slice(0, 13)}`,
          file: key,
          name: doc.name,
          start: at,
          at,
          agent: { name, ...this.client(name, key) },
          artboards: [],
          summary: "",
          kind: "changed",
        },
        added: new Set(),
        removed: new Set(),
      };
      this.runs.set(slot, run);
    }
    const { added, removed } = created(e.op, e.inverse);
    for (const id of added) run.added.add(id);
    for (const id of removed) {
      // Made and deleted in one run: as if it never was.
      if (run.added.delete(id))
        run.change.artboards = run.change.artboards.filter((a) => a.id !== id);
      else run.removed.add(id);
    }
    const gone = new Map(boardsIn(e.inverse).map((b) => [b.id, b]));
    const boards = new Map(run.change.artboards.map((a) => [a.id, a]));
    for (const id of e.artboards) {
      if (removed.includes(id) && !run.removed.has(id)) continue;
      const hit = findArtboard(doc, id);
      const was = gone.get(id);
      if (hit) boards.set(id, { id, name: hit.artboard.name, page: hit.page.id });
      else if (was) boards.set(id, { id, name: was.name, page: was.page });
    }
    const all = [...boards.values()];
    const kind =
      all.length && all.every((a) => run.added.has(a.id))
        ? "added"
        : all.length && all.every((a) => run.removed.has(a.id))
          ? "removed"
          : "changed";
    run.change = {
      ...run.change,
      name: doc.name,
      at,
      artboards: all,
      summary: summarize(doc, e.op),
      kind,
    };
    if (all.length) this.keep(run.change);
    // Everything it made, it deleted again: nothing to show.
    else this.drop(run.change);
    return all.length ? run.change : null;
  }

  /**
   * Changes since `since`, newest first: this server's, and what other Ponzu
   * processes on the Mac wrote to the database.
   */
  list(opts: { since?: number; file?: string; limit?: number } = {}): AgentChange[] {
    const limit = opts.limit ?? 100;
    const out = new Map<string, AgentChange>();
    for (const row of this.db.changes({ since: opts.since, path: opts.file, limit })) {
      try {
        out.set(row.id, JSON.parse(row.body) as AgentChange);
      } catch {
        // Written by a version that stored something else: skipped.
      }
    }
    // Memory wins: it's never behind, and it holds what a read-only database couldn't take.
    const files = opts.file ? [opts.file] : [...this.recent.keys()];
    for (const f of files)
      for (const c of this.recent.get(f) ?? []) if (c.at > (opts.since ?? 0)) out.set(c.id, c);
    return [...out.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  private keep(change: AgentChange): void {
    const list = (this.recent.get(change.file) ?? []).filter((c) => c.id !== change.id);
    list.push(change);
    if (list.length > CHANGES_KEPT) list.splice(0, list.length - CHANGES_KEPT);
    this.recent.set(change.file, list);
    this.db.putChange(
      { id: change.id, path: change.file, at: change.at, body: JSON.stringify(change) },
      CHANGES_KEPT,
    );
  }

  private drop(change: AgentChange): void {
    const list = this.recent.get(change.file);
    if (!list?.some((c) => c.id === change.id)) return;
    this.recent.set(
      change.file,
      list.filter((c) => c.id !== change.id),
    );
    this.db.dropChange(change.id);
  }

  /** The agent's product, for its mark: from its presence in this design, else its name. */
  private client(name: string, key: string): { client?: string } {
    const agents = this.presence().filter((p) => p.kind === "agent" && p.name === name);
    const p = agents.find((a) => a.file === key) ?? agents[0];
    if (p?.client) return { client: p.client };
    const n = name.toLowerCase();
    if (n.includes("claude")) return { client: "claude" };
    if (n.includes("codex")) return { client: "openai" };
    return {};
  }
}

/** Artboards an op made (`artboard.create`) and deleted (`artboard.delete`). */
function created(op: Op, inverse: Op): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const visit = (o: Op) => {
    if (o.op === "batch") return o.ops.forEach(visit);
    if (o.op === "artboard.create") added.push(o.artboard.id);
    else if (o.op === "artboard.delete") removed.push(o.id);
  };
  visit(op);
  // A page deleted with its artboards: its inverse makes them again.
  const restore = (o: Op) => {
    if (o.op === "batch") return o.ops.forEach(restore);
    if (o.op === "artboard.create" && !added.includes(o.artboard.id)) removed.push(o.artboard.id);
  };
  if (op.op === "page.delete" || (op.op === "batch" && op.ops.some((o) => o.op === "page.delete")))
    restore(inverse);
  return { added, removed: [...new Set(removed)] };
}

/** The artboards an inverse op would make again: what a deletion took, with their names. */
function boardsIn(op: Op): { id: string; name: string; page: string }[] {
  if (op.op === "batch") return op.ops.flatMap(boardsIn);
  if (op.op === "artboard.create")
    return [{ id: op.artboard.id, name: op.artboard.name, page: op.page }];
  return [];
}
