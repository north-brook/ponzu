import { type AnswerBody, ApiError, type Live, type QuestionRow } from "@ponzu/client";
import type { Ask, AskAnswer, Person } from "../cloud/model.ts";
import { mutate, type StorePonzu } from "./store-ponzu.ts";
import { toAsk } from "./thread-map.ts";

/*
 * What the agent waits on in one open canvas: the `canvas.questions` live query, which holds
 * the open questions alone, and the viewer's answers on their way. The first answer wins.
 *
 * A question that leaves while the viewer is on it (chose something, typed a note, or sent an
 * answer the API turned away with 409 `question_closed`) stays, so their choices don't vanish
 * without a word: Ponzu reads how it closed and the card says so until they put it away. When a
 * teammate answered, it names them and shows the answer that won in place of the viewer's own
 * choice; when the run withdrew it, it says Claude moved on. Only when that can't be read does it
 * say, neutrally, that it no longer waits.
 */

export class AskStore {
  private rows: readonly QuestionRow[] = [];
  /** Asks the viewer is answering now. */
  private sending = new Set<string>();
  /** Asks the viewer has started answering: chosen something in, or typed a note. */
  private touched = new Set<string>();
  /** Asks that left while the viewer was on them, as they were asked, while Ponzu reads how. */
  private settling = new Map<string, Ask>();
  /** Asks that closed while the viewer was on them, kept until put away. */
  private closed: Ask[] = [];
  private snapshot: Ask[] = [];
  private readonly listeners = new Set<() => void>();
  private stopLive: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly opts: {
      ponzu: StorePonzu;
      live: Pick<Live, "subscribe">;
      canvasId: string;
      /** Says, in a sentence, that an answer didn't go. */
      onError: (message: string) => void;
    },
  ) {}

  start(): this {
    this.stopLive = this.opts.live.subscribe(
      "canvas.questions",
      { canvasId: this.opts.canvasId },
      ({ rows }) => {
        const before = this.rows;
        this.rows = rows ?? [];
        const here = new Set(this.rows.map((row) => row.id));
        for (const row of before) {
          if (here.has(row.id)) continue;
          // An answer the run has taken is no longer on its way.
          const mine = this.sending.delete(row.id);
          const started = this.touched.delete(row.id);
          if (!mine && started) this.settle(toAsk(row), null);
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
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Ask[] => this.snapshot;

  answer(id: string, answer: AskAnswer): void {
    const body = bodyOf(answer);
    const row = this.rows.find((r) => r.id === id);
    const secret = "secret" in answer && row?.kind === "secret" ? answer.secret : null;
    if ((!body && secret === null) || !row || this.sending.has(id)) return;
    // As it was asked: it may leave the live rows before the API answers.
    const asked = toAsk(row);
    this.sending.add(id);
    this.emit();
    const { ponzu, canvasId } = this.opts;
    // A secret's value goes by its own route, never the generic answer's body.
    const sent =
      secret !== null
        ? mutate(ponzu, ponzu.mutations.answerSecret(), { canvasId, questionId: id, value: secret })
        : mutate(ponzu, ponzu.mutations.answerQuestion(), {
            canvasId,
            questionId: id,
            body: body!,
          });
    sent.then(
      () => this.emit(),
      (error: unknown) => {
        this.sending.delete(id);
        if (error instanceof ApiError && error.code === "question_closed") {
          this.settle(asked, answeredBy(error));
        } else {
          this.opts.onError(refusal(error));
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
    this.settling.delete(id);
    this.closed = this.closed.filter((ask) => ask.id !== id);
    this.emit();
  }

  /**
   * An ask that left while the viewer was on it: held, read-only, while Ponzu reads how it
   * closed, then kept as that. `by` is who the API's refusal named, if it did.
   */
  private settle(asked: Ask, by: Person | null): void {
    const { ponzu, canvasId } = this.opts;
    this.touched.delete(asked.id);
    this.settling.set(asked.id, asked);
    ponzu.queryClient.fetchQuery(ponzu.queries.question(canvasId, asked.id)).then(
      (question) => {
        // The rail resolves them to the member they are, picture and all.
        const who = question.answeredBy ? { ...question.answeredBy, avatarUrl: null } : by;
        if (question.status === "answered") {
          this.keep({ ...asked, status: "answered", answeredBy: who, given: question.answer });
        } else if (question.status === "cancelled") {
          this.keep({ ...asked, status: "cancelled" });
        } else {
          this.keep({ ...asked, status: by ? "answered" : "closed", answeredBy: by });
        }
      },
      () => this.keep({ ...asked, status: by ? "answered" : "closed", answeredBy: by }),
    );
  }

  private keep(ask: Ask): void {
    // Put away while Ponzu was still reading it: it stays away.
    if (this.stopped || !this.settling.delete(ask.id)) return;
    this.closed = [...this.closed.filter((kept) => kept.id !== ask.id), ask];
    this.emit();
  }

  private emit(): void {
    const kept = [...this.settling.values()].map((ask): Ask => ({ ...ask, status: "sending" }));
    const closedIds = new Set([...this.closed, ...kept].map((ask) => ask.id));
    const open = this.rows
      .filter((row) => !closedIds.has(row.id))
      .toSorted((a, b) => a.seq - b.seq)
      .map((row): Ask => {
        const ask = toAsk(row);
        return this.sending.has(row.id) ? { ...ask, status: "sending" } : ask;
      });
    this.snapshot = [...open, ...kept, ...this.closed];
    for (const listener of this.listeners) listener();
  }
}

/** Why an answer didn't go, in a sentence. */
function refusal(error: unknown): string {
  if (!(error instanceof ApiError)) return "Your answer didn't go through. Send it again.";
  switch (error.code) {
    case "network":
      return "Your answer didn't reach Ponzu. Check your connection and send it again.";
    case "secrets_full":
      return "This repo has no room for another secret. Remove one in Settings › Environments, then send it again.";
    case "secret_name_reserved":
      return "Claude asked for a name Ponzu keeps for itself, so it can't be a secret. Tell Claude to use another name.";
    case "no_repository":
      return "A Scratch canvas has no repository to keep a secret with.";
    default:
      return "Your answer didn't go through. Send it again.";
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
