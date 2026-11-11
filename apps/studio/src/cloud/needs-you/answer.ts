import type { Ask, AskAnswer, AskedQuestion } from "../model.ts";

/*
 * Answering what the agent asks. Everything it waits on is laid out as pages, one at a time in
 * the composer's slot: each question of a multiple-choice ask is a page of its own, and a plan,
 * a permission, a secret or a hand-off is one page. Send answers the page in view and moves on;
 * an ask is sent once its last page is answered, since the API takes all of an ask's answers at
 * once.
 */

export interface Page {
  ask: Ask;
  /** Which of a multiple-choice ask's questions; 0 for the other kinds. */
  index: number;
}

/** Every page of the asks, in order. */
export function pagesOf(asks: Ask[]): Page[] {
  return asks.flatMap((ask): Page[] =>
    ask.kind === "question"
      ? ask.questions.map((_, index) => ({ ask, index }))
      : [{ ask, index: 0 }],
  );
}

/** What the person has put on a page so far. */
export interface Draft {
  /** Chosen options' labels; for a plan, permission or hand-off, "yes" or "no". */
  chosen: string[];
  note: string;
}

export const EMPTY_DRAFT: Draft = { chosen: [], note: "" };

/** Chooses an option: one replaces the choice, or, on a multi-select question, joins or leaves it. */
export function choose(draft: Draft, label: string, multi: boolean): Draft {
  if (!multi) return { ...draft, chosen: draft.chosen[0] === label ? [] : [label] };
  return draft.chosen.includes(label)
    ? { ...draft, chosen: draft.chosen.filter((l) => l !== label) }
    : { ...draft, chosen: [...draft.chosen, label] };
}

/**
 * A page can be sent once it says something: an option chosen or a note written for a question,
 * a yes or no for a permission or a hand-off, the value for a secret. A plan is answered by
 * approving it, or by saying what to change, which keeps it planning.
 */
export function answerable(page: Page, draft: Draft): boolean {
  const note = draft.note.trim().length > 0;
  switch (page.ask.kind) {
    case "question":
    case "plan":
      return draft.chosen.length > 0 || note;
    case "permission":
    case "link":
      return draft.chosen.length > 0;
    case "secret":
      return note;
  }
}

/**
 * One question's answer, as the API keys it by the question's text: the chosen labels in the
 * options' order, then the note in the person's own words.
 */
export function questionAnswer(question: AskedQuestion, draft: Draft): string {
  const labels = question.options
    .map((o) => o.label)
    .filter((label) => draft.chosen.includes(label))
    .join(", ");
  const note = draft.note.trim();
  return labels && note ? `${labels}. ${note}` : labels || note;
}

/**
 * The ask's answer from the drafts of its pages, or null while a page of it isn't answerable.
 * `drafts[i]` is the draft of the ask's i-th page.
 */
export function answerOf(ask: Ask, drafts: Draft[]): AskAnswer | null {
  const pages = pagesOf([ask]);
  if (pages.some((page, i) => !answerable(page, drafts[i] ?? EMPTY_DRAFT))) return null;
  const first = drafts[0] ?? EMPTY_DRAFT;
  const note = first.note.trim() || undefined;
  switch (ask.kind) {
    case "question":
      return {
        answers: Object.fromEntries(
          ask.questions.map((q, i) => [q.question, questionAnswer(q, drafts[i] ?? EMPTY_DRAFT)]),
        ),
      };
    case "plan":
    case "permission":
    case "link":
      return { approved: first.chosen[0] === "yes", ...(note ? { note } : {}) };
    case "secret":
      return { secret: first.note };
  }
}

/**
 * The two choices of a plan or a permission, by the value they send. A hand-off has one: its
 * link, which says "yes" once opened.
 */
export const CHOICES: Record<
  "plan" | "permission",
  { yes: string; no: string; description?: { yes: string; no: string } }
> = {
  plan: {
    yes: "Approve",
    no: "Keep planning",
    description: { yes: "Claude starts on it.", no: "Claude revises it with your note." },
  },
  permission: { yes: "Allow", no: "Deny" },
};
