import type { AgentChange, CatalogFileAgent, Doc, Thread } from "@ponzu/core";
import type { PhoneFile } from "./files";

/**
 * What Activity lists, newest first, split into New (since the person last
 * looked) and Seen. Built from what the phone can know:
 *
 * - Changes: what agents changed, from each Mac's history (`/api/activity`):
 *   "Claude changed 12 artboards", with the first few as thumbnails.
 * - Replies: an agent's messages in a thread after the person's own last
 *   message there, from the docs of designs opened on this phone.
 * - Resolved: threads the person started that an agent resolved.
 * - Work: a design an agent is in right now, from each Mac's catalog. A Mac
 *   too old to keep a history also lists a design that changed since the
 *   person last opened it here.
 */
export type ActivityItem =
  | {
      kind: "change";
      id: string;
      file: PhoneFile;
      change: AgentChange;
      author: string;
      client?: string;
      /** The pages its artboards are on, with their icons. */
      pages: Place[];
      at: number;
    }
  | {
      kind: "reply";
      id: string;
      file: PhoneFile;
      thread: Thread;
      author: string;
      client?: string;
      text: string;
      /** The board it's pinned to, with its page's icon. */
      board?: Place;
      at: number;
    }
  | {
      kind: "resolved";
      id: string;
      file: PhoneFile;
      threads: Thread[];
      author: string;
      client?: string;
      boards: (Place & { id: string })[];
      at: number;
    }
  | {
      kind: "work";
      id: string;
      file: PhoneFile;
      agent?: CatalogFileAgent;
      pageName?: string;
      boards: { id: string; name: string }[];
      at: number;
    };

/** A page or a board in an item's where-line: its name, and the page's icon (design.json's names). */
export interface Place {
  name: string;
  icon?: string;
}

export interface ActivityInput {
  files: PhoneFile[];
  /**
   * What agents changed, by Mac, thumbnail URLs absolute. Null for a Mac too
   * old to keep a history; missing while it hasn't said.
   */
  changes?: Record<string, AgentChange[] | null>;
  /** Threads and artboard names of designs opened on the phone, by `<mac>:<key>`. */
  docs: Record<string, Pick<Doc, "threads" | "pages">>;
  /** When the person last looked, by `<mac>:<key>` (see seen.ts). */
  seen: Record<string, number>;
  /** When the person last opened Activity. */
  activitySeenAt: number;
}

/** An agent's product, for its mark, from a thread author's name. */
export function clientOf(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex") || n.includes("openai") || n.includes("gpt")) return "openai";
  return undefined;
}

/** "Claude" from "Claude Code" or "claude-code". */
export function shortAgent(name: string): string {
  const c = clientOf(name);
  if (c === "claude") return "Claude";
  if (c === "openai") return "Codex";
  return name.split(/[\s-]/)[0] ?? name;
}

/** A board by id, with its page's icon. */
function board(doc: Pick<Doc, "pages">, id?: string): Place | undefined {
  if (!id) return undefined;
  for (const p of doc.pages)
    for (const a of p.artboards) if (a.id === id) return { name: a.name, icon: p.icon };
  return undefined;
}

export function buildActivity(input: ActivityInput): ActivityItem[] {
  const out: ActivityItem[] = [];
  const byKey = new Map(input.files.map((f) => [`${f.mac}:${f.key}`, f]));
  for (const [mac, changes] of Object.entries(input.changes ?? {})) {
    for (const change of changes ?? []) {
      // A design this phone doesn't list (archived away, or gone) has nowhere to open.
      const file = byKey.get(`${mac}:${change.file}`);
      if (!file || !change.artboards.length) continue;
      const pages = [...new Set(change.artboards.map((a) => a.page))]
        .map((id) => file.pages.find((p) => p.id === id))
        .filter((p) => p !== undefined)
        .map((p) => ({ name: p.name, icon: p.icon }));
      out.push({
        kind: "change",
        id: `change:${mac}:${change.id}`,
        file,
        change,
        author: shortAgent(change.agent.name),
        client: change.agent.client ?? clientOf(change.agent.name),
        pages,
        at: change.at,
      });
    }
  }
  for (const file of input.files) {
    const k = `${file.mac}:${file.key}`;
    const doc = input.docs[k];
    if (doc) {
      const resolved = new Map<string, Thread[]>();
      for (const t of doc.threads) {
        const mine = t.messages.filter((m) => m.author.kind === "user");
        if (!mine.length) continue;
        const lastMine = mine[mine.length - 1]!.createdAt;
        const replies = t.messages.filter(
          (m) => m.author.kind === "agent" && m.createdAt > lastMine,
        );
        const reply = replies[replies.length - 1];
        if (reply && t.status === "open")
          out.push({
            kind: "reply",
            id: `reply:${k}:${t.id}`,
            file,
            thread: t,
            author: shortAgent(reply.author.name),
            client: clientOf(reply.author.name),
            text: reply.text,
            board: board(doc, t.artboardId),
            at: reply.createdAt,
          });
        if (t.status === "resolved" && t.messages[0]?.author.kind === "user") {
          const by = [...t.messages].reverse().find((m) => m.author.kind === "agent");
          if (!by) continue;
          const name = shortAgent(by.author.name);
          resolved.set(name, [...(resolved.get(name) ?? []), t]);
        }
      }
      for (const [author, threads] of resolved) {
        const at = Math.max(...threads.map((t) => t.updatedAt));
        const boards = [
          ...new Map(
            threads
              .filter((t) => t.artboardId)
              .map((t) => [t.artboardId!, board(doc, t.artboardId) ?? { name: "" }] as const),
          ),
        ].map(([id, place]) => ({ id, ...place }));
        out.push({
          kind: "resolved",
          id: `resolved:${k}:${author}`,
          file,
          threads,
          author,
          client: clientOf(author),
          boards,
          at,
        });
      }
    }
    const agent = file.agents?.find((a) => a.activity === "working") ?? file.agents?.[0];
    const seenAt = input.seen[k];
    // A Mac with a history says what changed; one without says only that something did.
    const history = input.changes?.[file.mac] !== null;
    const changed = !history && seenAt !== undefined && file.modified > seenAt + 1000;
    if (agent || changed) {
      out.push({
        kind: "work",
        id: `work:${k}`,
        file,
        agent,
        boards: [],
        at: file.modified,
      });
    }
  }
  // An agent at work right now leads; the rest, newest first.
  const live = (i: ActivityItem) => (i.kind === "work" && i.agent ? 1 : 0);
  return out.sort((a, b) => live(b) - live(a) || b.at - a.at);
}

/** New: since the person last opened Activity, or unseen work in a design. */
export function isNew(item: ActivityItem, input: Pick<ActivityInput, "seen" | "activitySeenAt">) {
  // A design the phone first hears of counts as seen as it stands (seen.ts), changes and all:
  // what an agent changed is new until Activity is opened.
  if (item.kind === "change") return item.at > input.activitySeenAt;
  if (item.kind === "work") {
    // An agent at work now is news until you've looked at the design.
    const seenAt = input.seen[`${item.file.mac}:${item.file.key}`];
    const unseen = seenAt !== undefined && item.at > seenAt + 1000;
    return unseen && (item.agent?.activity === "working" || item.at > input.activitySeenAt);
  }
  return item.at > input.activitySeenAt;
}

/** The title an item reads as. */
export function title(item: ActivityItem): string {
  switch (item.kind) {
    case "change": {
      const n = item.change.artboards.length;
      const verb = { added: "added", removed: "removed", changed: "changed" }[item.change.kind];
      return `${item.author} ${verb} ${n} ${n === 1 ? "artboard" : "artboards"}`;
    }
    case "reply":
      return `${item.author} replied to you`;
    case "resolved":
      return item.threads.length === 1
        ? `${item.author} resolved your comment`
        : `${item.author} resolved ${item.threads.length} of your comments`;
    case "work":
      if (item.agent) {
        const who = shortAgent(item.agent.name);
        return item.agent.activity === "working" ? `${who} is working` : `${who} is iterating`;
      }
      return "Changed since you looked";
  }
}

/**
 * Where an item is, as its second line reads: the file, then each page (a
 * change) or board (a reply, a resolve) with its page's icon. Work in a
 * design now reads as the agent's status instead, so it has none.
 */
export function where(item: ActivityItem): { file: string; places: Place[] } | null {
  switch (item.kind) {
    case "change":
      return { file: item.file.name, places: item.pages };
    case "reply":
      return { file: item.file.name, places: item.board ? [item.board] : [] };
    case "resolved":
      return { file: item.file.name, places: item.boards.filter((b) => b.name) };
    case "work":
      return null;
  }
}

/** The artboard a change opens on: its first one still there. */
export function changeTarget(item: Extract<ActivityItem, { kind: "change" }>): string | undefined {
  return item.change.artboards.find((a) => item.file.artboards.some((b) => b.id === a.id))?.id;
}
