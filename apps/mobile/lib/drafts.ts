import type { Doc } from "@ponzu/core";
import { useSyncExternalStore } from "react";
import type { PendingPin } from "../canvas/protocol";

export interface Draft {
  /** The canvas it's in, by id: what it is kept under on disk (`ponzu.drafts.<canvasId>`). */
  file: string;
  text: string;
  /** The thread a reply is in. */
  thread?: string;
  /** Where a new comment goes. */
  pin?: PendingPin & { nodeId?: string; offset?: { x: number; y: number } };
  /**
   * Sent, and not yet answered: the new thread's id (a comment) or the new message's (a reply).
   * Kept on disk with the words, so a phone that was killed before the API answered can tell,
   * from the canvas the API holds, whether the words got there (`settle`).
   */
  sending?: string;
}

/** Where drafts are kept on disk: AsyncStorage in the app, a map in tests. */
export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** One canvas's drafts on disk. Signing out removes every `ponzu.*` key, these with them. */
export const draftsStorageKey = (canvasId: string) => `ponzu.drafts.${canvasId}`;

export const draftKey = {
  comment: (file: string, p: PendingPin) =>
    `${file}\0pin:${p.artboardId ?? p.pageId}:${p.x}:${p.y}`,
  reply: (file: string, thread: string) => `${file}\0thread:${thread}`,
  /** What's being written to Ponzu in the canvas's chat. */
  chat: (file: string) => `${file}\0chat`,
};

/**
 * Unsent words, by what they're for (a new comment's pin, or a thread): kept as the composer
 * opens and closes, when its sheet is swiped away, when an agent changes the thread under it,
 * and on disk, so an app iOS evicted or killed keeps them (iPhone design §8). Gone once the API
 * has them, or the field is emptied. As desktop's (packages/canvas/src/drafts.ts).
 */
export class Drafts {
  private readonly drafts = new Map<string, Draft>();
  private readonly listeners = new Set<() => void>();
  private all: [string, Draft][] = [];
  private storage: DraftStorage | null;
  /** Canvases read from disk already (or being read). */
  private readonly loading = new Map<string, Promise<void>>();
  /**
   * Sent from this run of the app, with the words that were sent: never settled from a doc,
   * which has them already. What's written after them is kept in the same draft, after them.
   */
  private readonly inFlight = new Map<string, string>();
  /** Per canvas: the write under way, and whether another is due after it. */
  private readonly writes = new Map<string, { running: Promise<void>; again: boolean }>();

  constructor(storage: DraftStorage | null = null) {
    this.storage = storage;
  }

  /** Where to keep them: the app sets AsyncStorage once, before a canvas opens. */
  setStorage(storage: DraftStorage): void {
    this.storage = storage;
  }

  /** Hear of a draft arriving, going, moving or being sent (`set` says what counts). */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Every draft, with its key. The same array until something a listener hears changes. */
  snapshot = (): [string, Draft][] => this.all;

  get(key: string): Draft | undefined {
    return this.drafts.get(key);
  }

  /** This draft was sent from this run of the app and the API hasn't answered yet. */
  isSending(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** The words sent from this draft that the API hasn't answered for yet, if any. */
  sentWords(key: string): string | undefined {
    return this.inFlight.get(key);
  }

  /**
   * The send landed: its words leave the draft, and whatever was written after them stays, as an
   * unsent draft of its own. A field reopened while the send was out shows only those later words.
   */
  landed(key: string, words?: string): void {
    const d = this.drafts.get(key);
    const sent = this.inFlight.get(key) ?? words;
    this.inFlight.delete(key);
    if (!d) return;
    const { sending: _, ...rest } = d;
    const text = sent && d.text.startsWith(sent) ? d.text.slice(sent.length).trim() : "";
    this.set(key, { ...rest, text });
  }

  /**
   * Keep what a field holds; emptied, its draft goes. Listeners hear of a draft arriving, going
   * or moving (its pin or thread), and of its words coming to or going from something worth a
   * pin, never of the words themselves changing: what listens (the pins left unsent, the threads
   * being written) can't tell one word from the next, and every keystroke would otherwise render
   * the whole canvas screen. `get` always has the latest words.
   */
  set(key: string, draft: Draft): void {
    const was = this.drafts.get(key);
    if (draft.text) this.drafts.set(key, draft);
    else {
      this.inFlight.delete(key);
      if (!this.drafts.delete(key)) return;
    }
    this.persist(draft.file);
    if (was && draft.text && unsent(was) === unsent(draft) && samePlace(was, draft)) return;
    this.changed();
  }

  /**
   * The draft was sent as the op that makes `id` (a thread, or a message), or, with no id, the
   * send was refused and the words are unsent again.
   */
  markSending(key: string, id: string | undefined): void {
    const d = this.drafts.get(key);
    if (!d) return;
    const { sending: _, ...rest } = d;
    this.drafts.set(key, id ? { ...rest, sending: id } : rest);
    if (id) this.inFlight.set(key, d.text);
    else this.inFlight.delete(key);
    this.persist(d.file);
    this.changed();
  }

  /**
   * A new comment's draft moved to another spot: its words go with its pin, kept under the key
   * the new spot makes. Put down where it was, it still takes the layer now under it.
   */
  move(from: string, to: string, pin: NonNullable<Draft["pin"]>): void {
    const d = this.drafts.get(from);
    if (!d) return;
    this.drafts.delete(from);
    this.drafts.set(to, { ...d, pin });
    this.persist(d.file);
    this.changed();
  }

  /**
   * Read a canvas's drafts from disk, once: what this run of the app holds already wins. Never
   * fails: a draft that can't be read is a draft that isn't there.
   */
  load(file: string): Promise<void> {
    let loading = this.loading.get(file);
    if (!loading) {
      loading = this.read(file);
      this.loading.set(file, loading);
    }
    return loading;
  }

  /**
   * The canvas as the API holds it is in: a draft sent before the app last stopped, whose
   * thread or message is in it, got there, and goes. One still missing was lost with the app,
   * and stays, to send again. Only ever with the API's own doc, never the cached copy (which
   * holds what was waiting to be sent), and never for what this run is sending now.
   */
  settle(file: string, doc: Doc): void {
    let gone = false;
    for (const [key, d] of [...this.drafts]) {
      if (d.file !== file || !d.sending || this.inFlight.has(key)) continue;
      if (!landed(doc, d)) continue;
      this.drafts.delete(key);
      gone = true;
    }
    if (!gone) return;
    this.persist(file);
    this.changed();
  }

  /**
   * The canvas was closed (its CloudSource with it) with sends still unanswered. Its replica
   * dropped what it was waiting to send, and will never answer for what it had posted, so those
   * drafts are no longer this run's: the next open settles them from the API's doc, as after a
   * kill, and shows them as unsent pins until it does. Without this, a comment queued offline and
   * left behind would stay hidden as "sending" until the app restarted.
   */
  release(file: string): void {
    let any = false;
    for (const key of [...this.inFlight.keys()]) {
      if (this.drafts.get(key)?.file !== file) continue;
      this.inFlight.delete(key);
      any = true;
    }
    if (any) this.changed();
  }

  /** Every write to disk so far, done. */
  async flush(): Promise<void> {
    while (this.writes.size) await Promise.all([...this.writes.values()].map((w) => w.running));
  }

  /** Signing out: nothing of the person's stays in memory (their keys on disk go with sign-out). */
  clear(): void {
    this.drafts.clear();
    this.inFlight.clear();
    this.loading.clear();
    this.changed();
  }

  private async read(file: string): Promise<void> {
    let stored: Record<string, Draft> = {};
    try {
      const raw = await this.storage?.getItem(draftsStorageKey(file));
      if (raw) stored = JSON.parse(raw) as Record<string, Draft>;
    } catch {
      return;
    }
    let added = false;
    for (const [key, d] of Object.entries(stored)) {
      if (this.drafts.has(key) || !d || typeof d.text !== "string" || d.file !== file) continue;
      this.drafts.set(key, d);
      added = true;
    }
    if (added) this.changed();
  }

  /** Write a canvas's drafts to disk: one write at a time, the last one with the latest words. */
  private persist(file: string): void {
    const storage = this.storage;
    if (!storage) return;
    const pending = this.writes.get(file);
    if (pending) {
      pending.again = true;
      return;
    }
    const entry = { running: Promise.resolve(), again: false };
    const write = async () => {
      do {
        entry.again = false;
        const mine = Object.fromEntries([...this.drafts].filter(([, d]) => d.file === file));
        try {
          if (Object.keys(mine).length === 0) await storage.removeItem(draftsStorageKey(file));
          else await storage.setItem(draftsStorageKey(file), JSON.stringify(mine));
        } catch {
          // Kept in memory still; the next change tries again.
        }
      } while (entry.again);
      this.writes.delete(file);
    };
    this.writes.set(file, entry);
    entry.running = write();
  }

  private changed(): void {
    this.all = [...this.drafts];
    for (const l of this.listeners) l();
  }
}

function samePlace(a: Draft, b: Draft): boolean {
  return (
    a.file === b.file &&
    a.thread === b.thread &&
    a.sending === b.sending &&
    JSON.stringify(a.pin) === JSON.stringify(b.pin)
  );
}

/** The thread (a comment) or the message (a reply) the draft was sent as is in the doc. */
function landed(doc: Doc, d: Draft): boolean {
  if (d.thread) {
    return doc.threads.some((t) => t.id === d.thread && t.messages.some((m) => m.id === d.sending));
  }
  return doc.threads.some((t) => t.id === d.sending);
}

/** Whether a draft holds anything worth keeping a place for. */
export function unsent(d: Draft): boolean {
  return d.text.trim().length > 0;
}

/** The app's drafts. */
export const drafts = new Drafts();

export const getDraft = (key: string) => drafts.get(key);
export const setDraft = (key: string, draft: Draft) => drafts.set(key, draft);
export const moveDraft = (from: string, to: string, pin: NonNullable<Draft["pin"]>) =>
  drafts.move(from, to, pin);
export const subscribeDrafts = (listener: () => void) => drafts.subscribe(listener);

/** Every draft, with its key. */
export function useDrafts(): [string, Draft][] {
  return useSyncExternalStore(drafts.subscribe, drafts.snapshot, drafts.snapshot);
}
