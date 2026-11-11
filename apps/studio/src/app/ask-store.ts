import { type AnswerBody, ApiError, type Live, type QuestionRow } from "@ponzu/client";
import type { Ask, AskAnswer, Person } from "../cloud/model.ts";
import { mutate, type StorePonzu } from "./store-ponzu.ts";
import { toAsk } from "./thread-map.ts";

/*
 * What the agent waits on in one open design: the `design.questions` live query, which holds
 * the open questions alone, and the viewer's answers on their way. The first answer wins: when
 * someone else's got there first, the API says so (409 `question_closed`, naming who) and the ask
 * stays, put calmly with their name, until the viewer puts it away. A question the run withdrew, or a teammate answered,
 * leaves with its row; when the viewer had started answering it, it stays, closed, saying so,
 * until they put it away, so their choices don't vanish without a word.
 */

export class AskStore {
  private rows: readonly QuestionRow[] = [];
  /** Asks the viewer is answering now. */
  private sending = new Set<string>();
  /** Asks the viewer has started answering: chosen something in, or typed a note. */
  private touched = new Set<string>();
  /** Asks someone else answered first, kept until put away. */
  private closed: Ask[] = [];
  private snapshot: Ask[] = [];
  private readonly listeners = new Set<() => void>();
  private stopLive: (() => void) | null = null;

  constructor(
    private readonly opts: {
      ponzu: StorePonzu;
      live: Pick<Live, "subscribe">;
      designId: string;
      /** Says, in a sentence, that an answer didn't go. */
      onError: (message: string) => void;
    },
  ) {}

  start(): this {
    this.stopLive = this.opts.live.subscribe(
      "design.questions",
      { designId: this.opts.designId },
      ({ rows }) => {
        const before = this.rows;
        this.rows = rows ?? [];
        const here = new Set(this.rows.map((row) => row.id));
        for (const row of before) {
          if (here.has(row.id)) continue;
          // An answer the run has taken is no longer on its way.
          const mine = this.sending.delete(row.id);
          const started = this.touched.delete(row.id);
          if (!mine && started) this.keepClosed({ ...toAsk(row), status: "closed" });
        }
        this.emit();
      },
    );
    return this;
  }

  close(): void {
    this.stopLive?.();
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Ask[] => this.snapshot;

  answer(id: string, answer: AskAnswer): void {
    const body = bodyOf(answer);
    const row = this.rows.find((r) => r.id === id);
    if (!body || !row || this.sending.has(id)) return;
    // As it was asked: it may leave the live rows before the API answers.
    const asked = toAsk(row);
    this.sending.add(id);
    this.emit();
    const { ponzu, designId } = this.opts;
    mutate(ponzu, ponzu.mutations.answerQuestion(), { designId, questionId: id, body }).then(
      () => this.emit(),
      (error: unknown) => {
        this.sending.delete(id);
        if (error instanceof ApiError && error.code === "question_closed") {
          this.keepClosed({ ...asked, status: "answered", answeredBy: answeredBy(error) });
        } else {
          this.opts.onError(
            error instanceof ApiError && error.code === "network"
              ? "Your answer didn't reach Ponzu. Check your connection and send it again."
              : "Your answer didn't go through. Send it again.",
          );
        }
        this.emit();
      },
    );
  }

  /** The viewer started answering this ask. */
  touch(id: string): void {
    if (this.rows.some((row) => row.id === id)) this.touched.add(id);
  }

  /** Puts away an ask that closed while the viewer was on it. */
  dismiss(id: string): void {
    this.closed = this.closed.filter((ask) => ask.id !== id);
    this.emit();
  }

  private keepClosed(ask: Ask): void {
    this.touched.delete(ask.id);
    this.closed = [...this.closed.filter((kept) => kept.id !== ask.id), ask];
  }

  private emit(): void {
    const closedIds = new Set(this.closed.map((ask) => ask.id));
    const open = this.rows
      .filter((row) => !closedIds.has(row.id))
      .toSorted((a, b) => a.seq - b.seq)
      .map((row): Ask => {
        const ask = toAsk(row);
        return this.sending.has(row.id) ? { ...ask, status: "sending" } : ask;
      });
    this.snapshot = [...open, ...this.closed];
    for (const listener of this.listeners) listener();
  }
}

/** Who the API says answered first, when someone did; null when it doesn't say. */
function answeredBy(error: ApiError): Person | null {
  const by = error.details?.answeredBy as Partial<Person> | undefined;
  if (typeof by?.id !== "string" || typeof by.login !== "string") return null;
  return { id: by.id, login: by.login, name: by.name ?? by.login, avatarUrl: null };
}

/** The answer as the API takes it. A secret's value is never sent this way. */
function bodyOf(answer: AskAnswer): AnswerBody | null {
  if ("answers" in answer) return { answers: answer.answers };
  if ("approved" in answer) {
    return { approved: answer.approved, ...(answer.note ? { note: answer.note } : {}) };
  }
  return null;
}
