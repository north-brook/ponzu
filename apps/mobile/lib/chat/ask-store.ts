import { type AnswerBody, type Api, ApiError, type Live, type QuestionRow } from "@ponzu/client";
import { type Ask, type AskAnswer, type Person, toAsk, who } from "@ponzu/client/model";
import { NEEDS_YOU } from "../copy";
import { sendFailed } from "./lines";

/*
 * What the agent waits on in one open canvas, on the phone (iPhone design §10): the
 * `canvas.questions` live query, which holds the open questions alone, and the person's answers
 * on their way. It is the Mac's AskStore (apps/studio/src/app/ask-store.ts) on the phone's own API
 * object, with one difference the design asks for: an ask that closes while the person is on it
 * (their answer refused with 409 `question_closed`, or a teammate's answer taking it away after
 * they started) is not kept as a card. It goes, the next one shows, and one line under the slot
 * says who answered it ("Someone already answered this." when Ponzu can't say).
 *
 * A question nobody here had started that a teammate answers elsewhere simply leaves with its live
 * row. Nothing is kept on disk: the live rows are the truth, and the drafts are the card's.
 */

export type QuestionApi = Pick<Api["canvases"], "answer" | "answerSecret" | "question">;

export interface AskSnapshot {
  /** The open asks in the order they were asked; the person's own on its way says `sending`. */
  asks: Ask[];
  /** The ids of every open question, for the thread to leave out their "Asked" lines. */
  open: ReadonlySet<string>;
  /** The live rows have arrived at least once. */
  loaded: boolean;
  /**
   * A line under the slot: an answer that didn't go, or an ask that someone else closed. `id`
   * changes with each, so the same words said twice still show again.
   */
  said: { id: number; text: string; failed: boolean } | null;
}

export interface AskStoreOptions {
  api: { canvases: QuestionApi };
  live: Pick<Live, "subscribe">;
  canvasId: string;
  /** The person, so their own earlier answer from another device reads as "You". */
  meId: string;
}

const EMPTY: AskSnapshot = { asks: [], open: new Set(), loaded: false, said: null };

export class AskStore {
  private rows: readonly QuestionRow[] = [];
  private loaded = false;
  /** Asks the person is answering now. */
  private sending = new Set<string>();
  /** Asks the person has started answering: chosen something in, or typed a note. */
  private touched = new Set<string>();
  private said: AskSnapshot["said"] = null;
  /** The ask the line is about, when it says how one closed. */
  private saidAbout: string | null = null;
  private saidCount = 0;
  /** Asks known closed whose live row hasn't gone yet: kept out of the slot. */
  private readonly gone = new Set<string>();
  private snapshot: AskSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private stopLive: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly opts: AskStoreOptions) {}

  start(): this {
    this.stopLive = this.opts.live.subscribe(
      "canvas.questions",
      { canvasId: this.opts.canvasId },
      ({ rows }) => {
        if (rows === undefined && !this.loaded) return;
        const before = this.rows;
        this.rows = rows ?? [];
        this.loaded = true;
        const here = new Set(this.rows.map((row) => row.id));
        for (const row of before) {
          if (here.has(row.id)) continue;
          // An answer the run has taken is no longer on its way.
          const mine = this.sending.delete(row.id);
          const started = this.touched.delete(row.id);
          if (!mine && started) this.closedUnder(row.id, null);
        }
        this.emit();
      },
    );
    return this;
  }

  close(): void {
    this.stopped = true;
    this.stopLive?.();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AskSnapshot => this.snapshot;

  /**
   * Sends an ask's answer. Once only: a second press while the first is on its way does nothing.
   * Resolves true when the API took it; false when it didn't (the line says why, and the ask is
   * open again for the person to send once more), or when it was closed already.
   */
  async answer(id: string, answer: AskAnswer): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    const body = bodyOf(answer);
    const secret = "secret" in answer && row?.kind === "secret" ? answer.secret : null;
    if (!row || this.sending.has(id) || (!body && secret === null)) return false;
    this.sending.add(id);
    this.touched.delete(id);
    this.say(null);
    this.emit();
    const { api, canvasId } = this.opts;
    try {
      // A secret's value goes by its own route, never the answer's body, and is never kept.
      if (secret !== null) await api.canvases.answerSecret(canvasId, id, secret);
      else await api.canvases.answer(canvasId, id, body!);
      this.emit();
      return true;
    } catch (error) {
      this.sending.delete(id);
      if (error instanceof ApiError && error.code === "question_closed") {
        this.closedUnder(id, answeredBy(error));
      } else {
        this.say(refusal(error), true);
      }
      this.emit();
      return false;
    }
  }

  /** The person started answering this ask. */
  touch(id: string): void {
    if (this.rows.some((row) => row.id === id)) this.touched.add(id);
  }

  /** Puts away the line under the slot. */
  clearSaid(): void {
    if (!this.said) return;
    this.say(null);
    this.emit();
  }

  /**
   * An ask that closed while the person was on it: it leaves at once (kept out of the slot until
   * its live row goes too), and the line says who answered it, then, once Ponzu has said how it
   * closed, who did or that the run moved on.
   */
  private closedUnder(id: string, by: Person | null): void {
    this.gone.add(id);
    const named = (person: Person | null) =>
      person ? NEEDS_YOU.answeredBy(who(person, this.opts.meId)) : NEEDS_YOU.answered;
    this.say(named(by), false, id);
    this.opts.api.canvases.question(this.opts.canvasId, id).then(
      (question) => {
        // Only while the line is still this ask's: a newer one isn't overwritten.
        if (this.stopped || this.saidAbout !== id || !this.said) return;
        const text =
          question.status === "cancelled"
            ? NEEDS_YOU.movedOn
            : question.status === "answered" && question.answeredBy
              ? named({ ...question.answeredBy, avatarUrl: null })
              : named(by);
        if (text === this.said.text) return;
        this.said = { ...this.said, text };
        this.emit();
      },
      () => {},
    );
  }

  private say(text: string | null, failed = false, about: string | null = null): void {
    this.saidAbout = text === null ? null : about;
    this.said = text === null ? null : { id: ++this.saidCount, text, failed };
  }

  private emit(): void {
    if (this.stopped) return;
    const here = new Set(this.rows.map((row) => row.id));
    for (const id of this.gone) if (!here.has(id)) this.gone.delete(id);
    // Sorted on a copy: Hermes has no Array.prototype.toSorted (hermes.test.ts).
    const asks = [...this.rows]
      .filter((row) => !this.gone.has(row.id))
      .sort((a, b) => a.seq - b.seq)
      .map((row): Ask => {
        const ask = toAsk(row);
        return this.sending.has(row.id) ? { ...ask, status: "sending" } : ask;
      });
    this.snapshot = { asks, open: here, loaded: this.loaded, said: this.said };
    for (const listener of this.listeners) listener();
  }
}

/** Why an answer didn't go, in a sentence. A billing limit says only its first and that it waits. */
export function refusal(error: unknown): string {
  if (!(error instanceof ApiError)) return NEEDS_YOU.failed;
  if (error.status === 402 || error.code === "maintenance") return sendFailed(error);
  switch (error.code) {
    case "network":
      return NEEDS_YOU.offline;
    case "secrets_full":
      return NEEDS_YOU.secretsFull;
    case "secret_name_reserved":
      return NEEDS_YOU.secretReserved;
    case "no_repository":
      return NEEDS_YOU.noRepository;
    default:
      return NEEDS_YOU.failed;
  }
}

/** Who the API says answered first, when someone did; null when it doesn't say. */
function answeredBy(error: ApiError): Person | null {
  const by = error.details?.answeredBy as Partial<Person> | undefined;
  if (typeof by?.id !== "string" || typeof by.login !== "string") return null;
  return {
    id: by.id,
    login: by.login,
    name: by.name ?? by.login,
    avatarUrl: typeof by.avatarUrl === "string" ? by.avatarUrl : null,
  };
}

/** The answer as the API takes it. A secret's value is never sent this way. */
function bodyOf(answer: AskAnswer): AnswerBody | null {
  if ("answers" in answer) return { answers: answer.answers };
  if ("approved" in answer) {
    return { approved: answer.approved, ...(answer.note ? { note: answer.note } : {}) };
  }
  return null;
}
