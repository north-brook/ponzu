import type { Actor, Doc, Op, Origin, Presence } from "@ponzu/core";
import type { Theme, ToCanvas } from "../../canvas/protocol";

/*
 * The canvas's replica (CloudSource, on the React Native side) told to the page that draws it
 * (iPhone design §7). The page applies each op it is sent to its own copy of the doc, as the
 * Mac's canvas does, so an agent's work develops in; the bridge's one job is to know when an op
 * is not enough and send the whole doc instead. Pure, and tested in bun over CloudSource and the
 * client's fake backend.
 *
 * The rule:
 * - An op CloudSource hears goes to the page as `op`, and the doc it came with is remembered:
 *   CloudSource then puts that same copy in its state, so the state that follows is not news.
 * - Any other new doc in the state (the first load, the cached copy, a resync after a 410, a
 *   rebuild after an op of the person's was refused) goes as `doc`. Nothing can change the doc
 *   without changing its identity, so this sees every change.
 * - That alone is not exact. While an op of the person's own is unanswered, the replica can
 *   rebuild its doc and, in the same breath, tell its listeners of someone else's op with the
 *   rebuilt doc: an op that landed under the person's, or beside one of theirs the API refused.
 *   The page would apply it on top of what it drew, in another order, or keep the refused edit.
 *   So until `saved()` resolves, others' ops are not sent one by one; the state after them goes
 *   as `doc`.
 * - The page saying `ready` (its first load, or a remount after iOS ended its process) gets
 *   everything again from scratch (`all`).
 */

/** What the bridge reads of CloudSource. */
export interface BridgeSource {
  getState(): { doc: Doc | null; presence: Presence[] };
  subscribe(listener: (state: { doc: Doc | null; presence: Presence[] }) => void): () => void;
  onOp?(listener: (op: Op, origin: Origin, doc: Doc) => void): () => void;
  /** Resolves once every op made here has been answered. */
  saved?(): Promise<void>;
  /** Where the canvas's files are, once known. */
  readonly assetBase?: string;
}

/** What the page needs from the screen to read a whole doc. */
export interface BridgeView {
  theme(): Theme;
  /**
   * The page the person is on (or a link asked for). The page takes it only when it opens on a
   * canvas, a remount included; a doc sent again keeps the page it shows.
   */
  page?(): string | undefined;
}

export class CanvasBridge {
  private send: ((msg: ToCanvas) => void) | null = null;
  private view: BridgeView = { theme: () => "light" };
  /** The doc the last op came with: the state that follows carries it. */
  private lastOpDoc: Doc | null = null;
  /** The doc last sent whole. */
  private lastSent: Doc | null = null;
  /** An op was held back from the page: the next state goes whole. */
  private stale = false;
  /** Ops of the person's own not yet answered by the API. */
  private ownUnanswered = 0;
  private presence: Presence[];
  private working: string[] = [];
  private offs: (() => void)[] = [];

  constructor(
    private readonly source: BridgeSource,
    private readonly opts: { canvasId: string; me: Pick<Actor, "id"> },
  ) {
    this.presence = source.getState().presence;
    this.offs.push(source.subscribe((state) => this.changed(state)));
    if (source.onOp) this.offs.push(source.onOp((op, origin, doc) => this.heard(op, origin, doc)));
  }

  /**
   * Speak to a page: `send` reaches it (and drops what it can't take yet, the page then asks for
   * `all` once it's ready). Returns the way to stop.
   */
  connect(send: (msg: ToCanvas) => void, view: BridgeView): () => void {
    this.send = send;
    this.view = view;
    return () => {
      if (this.send === send) this.send = null;
    };
  }

  /** Everything the page draws from, for a page that has just said `ready`. */
  all(): ToCanvas[] {
    const doc = this.source.getState().doc;
    this.stale = false;
    this.lastSent = doc;
    return [
      ...(doc ? [this.docMessage(doc)] : []),
      { t: "presence", presence: this.source.getState().presence },
      { t: "working", artboards: this.working },
    ];
  }

  /** The boards the agent works on, from the canvas's head: their rings. */
  setWorking(artboards: readonly string[]): void {
    if (same(artboards, this.working)) return;
    this.working = [...artboards];
    this.send?.({ t: "working", artboards: this.working });
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
    this.send = null;
  }

  private heard(op: Op, origin: Origin, doc: Doc): void {
    const own = origin.kind === "user" && origin.id === this.opts.me.id;
    if (own) {
      this.ownUnanswered++;
      const done = () => {
        this.ownUnanswered = Math.max(0, this.ownUnanswered - 1);
      };
      void (this.source.saved?.() ?? Promise.resolve()).then(done, done);
    } else if (this.ownUnanswered > 0) {
      // It may have landed under the person's own: the doc after it goes whole.
      this.stale = true;
      return;
    }
    if (this.stale) return;
    this.lastOpDoc = doc;
    this.send?.({ t: "op", op, origin });
  }

  private changed(state: { doc: Doc | null; presence: Presence[] }): void {
    const { doc } = state;
    if (doc && (this.stale || (doc !== this.lastOpDoc && doc !== this.lastSent))) {
      this.stale = false;
      this.lastSent = doc;
      this.send?.(this.docMessage(doc));
    }
    if (state.presence !== this.presence) {
      this.presence = state.presence;
      this.send?.({ t: "presence", presence: state.presence });
    }
  }

  private docMessage(doc: Doc): ToCanvas {
    const page = this.view.page?.();
    return {
      t: "doc",
      doc,
      assetBase: this.source.assetBase ?? "",
      theme: this.view.theme(),
      file: this.opts.canvasId,
      ...(page ? { page } : {}),
    };
  }
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
