import type {
  BoardHit,
  CanvasHit,
  CommentHit,
  MessageHit,
  PersonHit,
  PullRequestHit,
  SearchResults,
} from "./model.ts";

// Splitting a result's text at its matches is search's own rule, in @ponzu/core with the rest of
// it (folding, terms, matches, snippets), where its tests are. The subpath imports nothing else.
export { type Segment, segments } from "@ponzu/core/search-text";

/**
 * One result, by what it is and where: unique within an answer, and the same from one answer to
 * the next, so the selection stays on its result as answers change. A page's or board's id, a
 * comment's or message's, is unique only within its canvas, so each names its canvas too.
 */
export type ResultKey =
  | `canvas:${string}`
  | `page:${string}`
  | `board:${string}`
  | `comment:${string}`
  | `message:${string}`
  | `pr:${string}`
  | `person:${string}`;

/** A result and what it is, for opening it. */
export type Result =
  | { kind: "canvas"; hit: CanvasHit }
  | { kind: "page"; hit: BoardHit }
  | { kind: "board"; hit: BoardHit }
  | { kind: "comment"; hit: CommentHit }
  | { kind: "message"; hit: MessageHit }
  | { kind: "pr"; hit: PullRequestHit }
  | { kind: "person"; hit: PersonHit };

/** The group a result is in, as `search result opened` names it. */
export type ResultGroup =
  | "canvases"
  | "boards"
  | "comments"
  | "messages"
  | "pullRequests"
  | "people";

export function resultKey(result: Result): ResultKey {
  switch (result.kind) {
    case "canvas":
      return `canvas:${result.hit.canvas.id}`;
    case "page":
    case "board":
      return `${result.kind}:${result.hit.canvas.id}/${result.hit.id}`;
    case "comment":
      return `comment:${result.hit.canvas.id}/${result.hit.threadId}/${result.hit.id}`;
    case "message":
      return `message:${result.hit.canvas.id}/${result.hit.id}`;
    case "pr":
      return `pr:${result.hit.canvas.id}/${result.hit.number}`;
    case "person":
      return `person:${result.hit.id}`;
  }
}

export function resultGroup(result: Result): ResultGroup {
  switch (result.kind) {
    case "canvas":
      return "canvases";
    case "page":
    case "board":
      return "boards";
    case "comment":
      return "comments";
    case "message":
      return "messages";
    case "pr":
      return "pullRequests";
    case "person":
      return "people";
  }
}

/**
 * Every result in the order the list shows them: canvases, boards (pages and boards as the
 * server ranked them), comments, messages, pull requests, people. A key that comes up twice (an
 * answer can't hold one twice, but nothing here leans on that) is kept the first time.
 */
export function listResults(answer: SearchResults): Result[] {
  const all: Result[] = [
    ...answer.canvases.map((hit) => ({ kind: "canvas" as const, hit })),
    ...answer.boards.map((hit) => ({ kind: hit.place, hit })),
    ...answer.comments.map((hit) => ({ kind: "comment" as const, hit })),
    ...answer.messages.map((hit) => ({ kind: "message" as const, hit })),
    ...answer.pullRequests.map((hit) => ({ kind: "pr" as const, hit })),
    ...answer.people.map((hit) => ({ kind: "person" as const, hit })),
  ];
  const seen = new Set<ResultKey>();
  return all.filter((result) => {
    const key = resultKey(result);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every result's key in the order the list shows them, for moving through with the keyboard. */
export function resultKeys(answer: SearchResults): ResultKey[] {
  return listResults(answer).map(resultKey);
}

/** The result `key` names, and its place in the list from 0; null once it is gone. */
export function resultAt(
  answer: SearchResults,
  key: ResultKey,
): { result: Result; position: number } | null {
  const all = listResults(answer);
  const position = all.findIndex((result) => resultKey(result) === key);
  return position < 0 ? null : { result: all[position]!, position };
}

/**
 * Where the selection goes on an arrow key. It stops at the ends rather than wrapping, as a Mac
 * list does. Null for a key that doesn't move it: Home and End stay the field's, for the caret.
 */
export function moveSelection(count: number, index: number, key: string): number | null {
  if (count === 0) return null;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp") return Math.max(0, index - 1);
  return null;
}
