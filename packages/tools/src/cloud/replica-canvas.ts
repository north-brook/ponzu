import {
  type Actor,
  authorOf,
  type Doc,
  type Dropped,
  type DroppedOp,
  findArtboard,
  type Op,
  type OpInfo,
  type Replica,
  sanitizeOp,
  summarize,
  threadEvents,
  touchedArtboards,
} from "@ponzu/core";
import type { Applied, ToolCanvas } from "../canvas.ts";
import type { EventHub, PresenceHub } from "../context.ts";
import { droppedNote } from "../util.ts";

/**
 * How often `settled` has the replica try again while the API isn't answering: as often as
 * the replica's own first retry.
 */
const SETTLE_RETRY_MS = 500;

/**
 * A canvas in the cloud, as the tools reach it: a `Replica` of it in this process. Reads are
 * the replica's own view. An edit applies to that view at once and goes to the API behind the
 * tool's back, so no tool waits on the network.
 *
 * Three things follow from editing ahead of the API, and all are handled here. The view has to
 * be what the API will commit, so an edit is sanitized as the API would before it is applied,
 * and `notices` says what that took out. Other people's ops arrive while the agent works, and
 * are told to the same event and presence hubs the agent's own are. And an edit the agent
 * already saw succeed can still be undone, when the API refuses it or someone else's change
 * leaves it nothing to apply to: `notices` says that too, for the agent's next tool result.
 */
export class ReplicaCanvas implements ToolCanvas {
  /** What sanitizing took out of the agent's edits, not yet told. */
  private removed: Dropped[] = [];
  private undone: DroppedOp[] = [];
  private readonly stop: (() => void)[];

  constructor(
    private readonly replica: Replica,
    private readonly hubs: { key: string; events: EventHub; presence: PresenceHub },
  ) {
    this.stop = [
      replica.onOp((op, actor, doc, info) => this.heard(op, actor, doc, info)),
      replica.onDrop((dropped) => this.undone.push(dropped)),
      replica.subscribe(() => this.release()),
    ];
  }

  get doc(): Doc {
    return this.replica.doc;
  }

  /**
   * The op goes in as the API will commit it: sanitized first (`sanitizeOp`, the API's own
   * step), so nothing shows here, in a read or a screenshot, that the commit would take away.
   * The origin is the replica's actor whatever is passed: the API takes it from the runner's
   * token.
   */
  apply(given: Op): Applied {
    const removed: Dropped[] = [];
    const op = sanitizeOp(given, removed);
    const before = touchedArtboards(this.replica.doc, op);
    const { inverse } = this.replica.apply(op);
    this.removed.push(...removed);
    const doc = this.replica.doc;
    const artboards = [
      ...new Set([...before, ...touchedArtboards(doc, op), ...touchedArtboards(doc, inverse)]),
    ];
    this.hubs.events.emitOp(this.hubs.key, doc, { op, origin: this.author, artboards });
    return { artboards };
  }

  /**
   * Resolves true once every edit made here has reached the API, which has committed it or
   * said it won't, and false if `timeoutMs` passes first: the API can't be reached, or is
   * slow. For the end of a turn and before the sandbox sleeps; an edit still pending when the
   * process stops is lost. Ask `notices` afterwards for what was undone.
   *
   * While it waits the replica is kept trying. Left alone, a replica that has failed a few
   * requests waits up to half a minute before the next, which would report an API that came
   * back seconds ago as out of reach.
   */
  settled(timeoutMs: number): Promise<boolean> {
    if (!this.replica.pending.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        clearInterval(retry);
        off();
        resolve(ok);
      };
      const off = this.replica.subscribe(() => {
        if (!this.replica.pending.length) done(true);
      });
      const timer = setTimeout(() => done(false), timeoutMs);
      const retry = setInterval(() => this.replica.retryNow(), SETTLE_RETRY_MS);
      this.replica.retryNow();
    });
  }

  /**
   * What the agent has to hear about its edits since this was last asked, in words for it:
   * what was left out of one as it was made, and which were undone afterwards. Asking takes
   * them, so each is told once.
   */
  notices(): string[] {
    const said: string[] = [];
    const removed = this.removed.splice(0);
    if (removed.length) said.push(droppedNote(removed).trimStart());
    const dropped = this.undone.splice(0);
    if (dropped.length) {
      const doc = this.replica.doc;
      const one = dropped.length === 1;
      said.push(
        [
          `Undone: ${one ? "an edit" : `${dropped.length} edits`} you made earlier ${one ? "is" : "are"} not in the canvas, though the tool said ${one ? "it was" : "they were"}.`,
          ...dropped.map((d) => `- ${describe(doc, d.op)}: ${why(d)}`),
          `Look at what is there now (get_tree, get_html) before you make ${one ? "it" : "them"} again.`,
        ].join("\n"),
      );
    }
    return said;
  }

  /** Stop listening to the replica. */
  close(): void {
    for (const off of this.stop) off();
  }

  private get author() {
    return authorOf(this.replica.actor);
  }

  /** An op reached the replica's view. */
  private heard(op: Op, actor: Actor, doc: Doc, info: OpInfo): void {
    // The agent's own op was told as it was applied, with everything it touched. The API's
    // version of it, heard again as an echo, is no news.
    if (info.seq === undefined || info.echo) return;
    const { key, events } = this.hubs;
    // Read after the op: a node it removed no longer says which artboard it was in.
    events.emitOp(key, doc, { op, origin: authorOf(actor), artboards: touchedArtboards(doc, op) });
  }

  /**
   * Nobody is working on an artboard that is gone. Checked whenever the replica changes and
   * not per op: a whole fetched document brings deletions no op told of, and an artboard the
   * agent made goes with the edit when that is undone.
   */
  private release(): void {
    const { key, presence } = this.hubs;
    const doc = this.replica.doc;
    const gone = presence
      .list()
      .flatMap((p) => p.working)
      .filter((id) => !findArtboard(doc, id));
    if (gone.length) presence.removed(key, gone);
  }
}

/** A few words on an edit that was undone, read against the canvas without it. */
function describe(doc: Doc, op: Op): string {
  const said = threadEvents(op).map((e) => {
    if (e.kind === "created") return `your comment "${clip(e.thread.messages[0]?.text ?? "")}"`;
    if (e.kind === "message") return `your reply in ${e.id} "${clip(e.text)}"`;
    if (e.kind === "edited") return `your edit to a message in ${e.id}`;
    return `marking ${e.id} ${e.status}`;
  });
  return said.length ? said.join("; ") : summarize(doc, op);
}

function why(dropped: DroppedOp): string {
  const reason = dropped.reason.replace(/\.$/, "");
  return dropped.cause === "rejected"
    ? `Ponzu refused it (${reason}).`
    : `it no longer fit once someone else's change landed first (${reason}).`;
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
