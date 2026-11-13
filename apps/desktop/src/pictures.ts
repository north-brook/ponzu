import type { PictureAnswer, PictureRequest } from "./bridge.ts";

/*
 * Comments' pictures, drawn out of the person's window (docs/cloud.md, "Comments"). Drawing one
 * lays the boards round a comment's pin out off screen and copies them into an image, which takes
 * a renderer's main thread for a while, and Chromium keeps each image's address for as long as
 * its page lives. So the shell draws them in a hidden window of its own, with its own renderer:
 * the studio again, in its picture mode (apps/studio/src/app/picture-host.ts). The person's
 * window only sends the document and gets two small files back.
 *
 * The hidden window opens when a picture is asked for, draws one at a time in the order asked,
 * and closes once nothing has been asked for a while, or after a few pictures, so what Chromium
 * keeps of each goes with it. A picture that takes too long, or a window that goes away, answers
 * `failed`; the next picture opens a new window.
 */

/** The hidden window, as `Pictures` drives it (main.ts makes the real one). */
export interface PictureWindow {
  send(id: number, request: PictureRequest): void;
  destroy(): void;
}

export interface PicturesOptions {
  /**
   * Opens a hidden picture window. It calls `ready` once its studio listens, and `gone` if it
   * closes or its renderer goes away without being asked to.
   */
  open(events: { ready: () => void; gone: () => void }): PictureWindow;
  /** How long one picture may take, the window's start included, before it is given up on. */
  drawMs?: number;
  /** How long the window stays open with nothing to draw. */
  idleMs?: number;
  /** Pictures one window draws before it is closed and the next opens a new one. */
  perWindow?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export const DRAW_MS = 30_000;
export const IDLE_MS = 20_000;
export const PER_WINDOW = 8;

interface Job {
  id: number;
  request: PictureRequest;
  resolve: (answer: PictureAnswer) => void;
}

interface Open {
  handle: PictureWindow;
  ready: boolean;
  drawn: number;
}

export class Pictures {
  private window: Open | null = null;
  private readonly queue: Job[] = [];
  private current: Job | null = null;
  private drawTimer: unknown = null;
  private idleTimer: unknown = null;
  private ids = 0;
  /** Windows opened in all, for the tests. */
  opened = 0;

  constructor(private readonly opts: PicturesOptions) {}

  draw(request: PictureRequest): Promise<PictureAnswer> {
    return new Promise((resolve) => {
      this.queue.push({ id: ++this.ids, request, resolve });
      this.pump();
    });
  }

  /** The picture window's answer to picture `id`; any other is ignored. */
  answered(id: number, answer: PictureAnswer): void {
    const job = this.current;
    if (!job || job.id !== id) return;
    this.finish(answer);
  }

  /** Closes the window and answers everything waiting: the person's window has gone. */
  close(): void {
    const waiting = [...(this.current ? [this.current] : []), ...this.queue.splice(0)];
    this.current = null;
    this.stopTimer("draw");
    this.stopTimer("idle");
    this.shut();
    for (const job of waiting) job.resolve(failed("Ponzu's window closed."));
  }

  /** Whether a picture window is open now. */
  get isOpen(): boolean {
    return this.window !== null;
  }

  private pump(): void {
    if (this.current || this.queue.length === 0) return;
    this.stopTimer("idle");
    const job = this.queue.shift()!;
    this.current = job;
    this.drawTimer = this.timer(() => {
      this.drawTimer = null;
      // A window that takes this long may be stuck: the next picture gets a new one.
      this.shut();
      this.finish(failed("The picture took too long."));
    }, this.opts.drawMs ?? DRAW_MS);
    if (!this.window) this.openWindow();
    else if (this.window.ready) this.send(job);
  }

  private openWindow(): void {
    this.opened++;
    const open: Open = { handle: null as unknown as PictureWindow, ready: false, drawn: 0 };
    this.window = open;
    open.handle = this.opts.open({
      ready: () => {
        if (this.window !== open || open.ready) return;
        open.ready = true;
        if (this.current) this.send(this.current);
      },
      gone: () => {
        if (this.window !== open) return;
        this.window = null;
        if (this.current) this.finish(failed("The picture window went away."));
      },
    });
  }

  private send(job: Job): void {
    const open = this.window!;
    open.drawn++;
    open.handle.send(job.id, job.request);
  }

  private finish(answer: PictureAnswer): void {
    const job = this.current;
    if (!job) return;
    this.current = null;
    this.stopTimer("draw");
    if (this.window && this.window.drawn >= (this.opts.perWindow ?? PER_WINDOW)) this.shut();
    job.resolve(answer);
    this.pump();
    if (!this.current && this.window) {
      this.idleTimer = this.timer(() => {
        this.idleTimer = null;
        if (!this.current) this.shut();
      }, this.opts.idleMs ?? IDLE_MS);
    }
  }

  private shut(): void {
    const open = this.window;
    this.window = null;
    open?.handle.destroy();
  }

  private timer(run: () => void, ms: number): unknown {
    return (this.opts.setTimer ?? ((r, t) => setTimeout(r, t)))(run, ms);
  }

  private stopTimer(which: "draw" | "idle"): void {
    const key = which === "draw" ? "drawTimer" : "idleTimer";
    if (this[key] === null) return;
    (this.opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this[key]);
    this[key] = null;
  }
}

function failed(message: string): PictureAnswer {
  return { ok: false, reason: "failed", message };
}

/** A picture request as the studio sent it, or null for anything else. */
export function pictureRequest(value: unknown): PictureRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const { doc, threadId, messageId, assetBase } = value as Record<string, unknown>;
  if (typeof doc !== "object" || doc === null) return null;
  if (typeof threadId !== "string" || typeof messageId !== "string") return null;
  if (assetBase !== undefined && typeof assetBase !== "string") return null;
  return { doc, threadId, messageId, ...(assetBase !== undefined ? { assetBase } : {}) };
}

/** A picture window's answer, or a `failed` one for anything malformed. */
export function pictureAnswer(value: unknown): PictureAnswer {
  const answer = value as Partial<Record<string, unknown>> | null;
  if (answer?.ok === true) {
    const { light, dark } = answer;
    if (light instanceof Uint8Array && dark instanceof Uint8Array) return { ok: true, light, dark };
  } else if (answer?.ok === false) {
    if (answer.reason === "empty") return { ok: false, reason: "empty" };
    if (answer.reason === "failed") {
      return failed(typeof answer.message === "string" ? answer.message : "It failed.");
    }
  }
  return failed("The picture window answered something else.");
}
