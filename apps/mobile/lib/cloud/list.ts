import type { CanvasListRow, QuestionRow } from "@ponzu/client";
import {
  type Ask,
  type CanvasPreview,
  type CanvasSummary,
  orderCanvases,
  orderSettled,
  type Person,
  type RowIndicator,
  rowIndicator,
  toAsk,
  toSummary,
  type WorkspaceKind,
} from "@ponzu/client/model";

/*
 * The canvases list as the phone draws it (docs/mobile.md, "The canvases list"), pure: the live
 * rows mapped through the shared `toSummary`, put in the Mac's order (`orderCanvases`, needs you
 * first on a team), settled ones apart in the tray (`orderSettled`), and for a row waiting on the
 * viewer, the first open question, which takes the row's third line.
 */

/** At most this many rows' questions are watched: the top needs-you rows. */
export const QUESTION_ROWS = 8;

/** The first open question on a canvas, as its row says it: a title and a line. */
export interface QuestionLine {
  header: string;
  text: string;
}

/** A row of the list: the canvas, and its question while it waits on the viewer. */
export interface ListRow {
  canvas: CanvasSummary;
  question: QuestionLine | null;
}

export interface CanvasList {
  /** Active canvases, in the Mac sidebar's order. */
  active: ListRow[];
  /** Settled canvases, most recently settled first: the tray. */
  settled: ListRow[];
}

/** What the rows need besides themselves. */
export interface ListContext {
  /** Personal or a team: on a team, canvases waiting on the viewer come first. */
  kind: WorkspaceKind;
  /** The workspace's members by id, for whose a canvas is. */
  people: ReadonlyMap<string, Person>;
  /** Where each canvas's files are, once its view has said: its previews are there. */
  assetsUrls: ReadonlyMap<string, string>;
  /** Each watched canvas's open questions (`canvas.questions`), by canvas id. */
  questions: ReadonlyMap<string, readonly QuestionRow[]>;
}

/**
 * What the needs-you strip calls each kind of ask, as the Mac's does (studio needs-you.tsx), and
 * the line under it: a question's own words, the plan's ask, a permission's title.
 */
export function askLine(ask: Ask): QuestionLine {
  switch (ask.kind) {
    case "question": {
      const first = ask.questions[0];
      return { header: first?.header ?? "Question", text: first?.question ?? "" };
    }
    case "plan":
      return { header: "Plan", text: "Approve the plan?" };
    case "permission":
      return { header: "Permission", text: ask.title };
    case "secret":
      return { header: "Secret", text: ask.description ?? ask.name };
    case "link":
      return { header: "Over to you", text: ask.title };
  }
}

/** The first question still open, oldest first, as its row says it; null when none is. */
export function firstQuestion(rows: readonly QuestionRow[] | undefined): QuestionLine | null {
  const open = (rows ?? []).filter((row) => row.status === "open");
  if (!open.length) return null;
  const first = open.reduce((a, b) => (b.seq < a.seq ? b : a));
  return askLine(toAsk(first));
}

export function buildList(rows: readonly CanvasListRow[], context: ListContext): CanvasList {
  const summaries = rows.map((row) => {
    const assetsUrl = context.assetsUrls.get(row.id);
    return toSummary(row, { people: context.people, ...(assetsUrl ? { assetsUrl } : {}) });
  });
  const row = (canvas: CanvasSummary): ListRow => ({
    canvas,
    question: canvas.needsYou > 0 ? firstQuestion(context.questions.get(canvas.id)) : null,
  });
  return {
    active: orderCanvases(
      summaries.filter((canvas) => canvas.status === "active"),
      context.kind,
    ).map(row),
    settled: orderSettled(summaries.filter((canvas) => canvas.status === "settled")).map(
      (canvas) => ({ canvas, question: null }),
    ),
  };
}

/** The canvases whose questions are watched: the first few active ones waiting on the viewer. */
export function questionWatch(rows: readonly CanvasListRow[], kind: WorkspaceKind): string[] {
  const active = rows.filter((row) => row.status === "active" && row.needsYouCount > 0);
  // The list's own order, so the rows on screen first are the ones watched.
  return orderCanvases(
    active.map((row) => toSummary(row, { people: new Map() })),
    kind,
  )
    .slice(0, QUESTION_ROWS)
    .map((canvas) => canvas.id);
}

/** The canvases whose view is asked for, for their previews: those that have one. */
export function previewWatch(rows: readonly CanvasListRow[]): string[] {
  return rows.filter((row) => row.previewSeq !== null).map((row) => row.id);
}

/** The preview's address in the phone's appearance. */
export function previewUri(preview: CanvasPreview | null, scheme: "light" | "dark"): string | null {
  return preview ? preview[scheme] : null;
}

/** What VoiceOver reads for a row, as the Mac's row label, with the question it waits on. */
export function rowLabel(
  canvas: CanvasSummary,
  indicator: RowIndicator | null,
  question: QuestionLine | null,
): string {
  const parts = [canvas.name];
  if (indicator?.kind === "needs_you") parts.push(`${indicator.count} waiting for you`);
  if (indicator?.kind === "working") parts.push("working");
  if (indicator?.kind === "unseen") parts.push("new activity");
  const { project } = canvas;
  parts.push(
    project.kind === "repo"
      ? `${project.repo.name}, ${project.branch}`
      : `Scratch, ${project.city}`,
  );
  if (canvas.pullRequest) parts.push(`pull request #${canvas.pullRequest.number}`);
  if (question) parts.push(`${question.header}: ${question.text}`);
  return parts.join(", ");
}

/** The indicator a row shows: none in the tray. */
export function indicatorOf(canvas: CanvasSummary): RowIndicator | null {
  return canvas.status === "settled" ? null : rowIndicator(canvas);
}
