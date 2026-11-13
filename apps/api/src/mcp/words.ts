import type { Doc } from "@ponzu/core";
import { canvasLink } from "../runner/session.ts";

/*
 * How the MCP's answers read. An agent reads them as text, so each says plainly what a person's
 * app shows: who is doing what, what is waiting on whom, and the ids to pass back.
 */

/** A canvas as the routes answer it, the fields the words use. */
export interface CanvasRowLike {
  id: string;
  name: string;
  /** owner/name, or null for Scratch. */
  repo?: string | null | { fullName: string };
  status: "active" | "settled";
  agentState: string;
  agentStatus: string | null;
  agentBlocker?: string | null;
  needsYouCount: number;
  prNumber: number | null;
  prState: string | null;
  prChecks?: string;
  lastActivityAt: string | Date;
  driver?: { name: string; host: string | null } | null;
}

export interface ThreadItemLike {
  id: string;
  seq: number;
  at: string;
  streaming: boolean;
  kind: "message" | "comment" | "assistant" | "tool" | "notice";
  payload: Record<string, unknown>;
}

export interface QuestionLike {
  id: string;
  kind: string;
  payload: unknown;
}

const CANVAS_ID = /^(?:cnv|des)_[0-9a-z]{16}$/;

/**
 * The canvas id a tool was given: an id, or a canvas link (with or without a page or board in
 * it). Anything else is passed on as it is, and the route says there's no such canvas.
 */
export function canvasRef(ref: string): string {
  const trimmed = ref.trim();
  const match = /\/(?:canvases|designs)\/((?:cnv|des)_[0-9a-z]{16})/.exec(trimmed);
  if (match) return match[1]!;
  if (CANVAS_ID.test(trimmed)) return trimmed;
  return encodeURIComponent(trimmed);
}

const AGENT_WORDS: Record<string, string> = {
  idle: "idle",
  waking: "waking up",
  working: "working",
  needs_you: "waiting on the person",
  limited: "paused at the Claude plan's limit",
};

/** A canvas in a few lines. */
export function canvasLines(canvas: CanvasRowLike): string[] {
  const repo =
    typeof canvas.repo === "object" && canvas.repo !== null ? canvas.repo.fullName : canvas.repo;
  const head = `${canvas.id} "${canvas.name}" · ${repo ?? "Scratch"}${canvas.status === "settled" ? " · settled (done)" : ""}`;
  const agent = canvas.driver
    ? `  ${canvas.driver.name}${canvas.driver.host ? ` (in ${canvas.driver.host})` : ""} is driving it; Ponzu's agent is off.`
    : `  Ponzu's agent: ${AGENT_WORDS[canvas.agentState] ?? canvas.agentState}${canvas.agentStatus ? ` · ${canvas.agentStatus}` : ""}${canvas.agentBlocker ? ` · blocked: ${canvas.agentBlocker}` : ""}`;
  const lines = [head, agent];
  if (canvas.needsYouCount > 0) {
    lines.push(`  ${canvas.needsYouCount} question${canvas.needsYouCount === 1 ? "" : "s"} open`);
  }
  if (canvas.prNumber !== null) {
    lines.push(
      `  pull request #${canvas.prNumber}: ${canvas.prState}${canvas.prChecks && canvas.prChecks !== "none" ? `, checks ${canvas.prChecks}` : ""}`,
    );
  }
  lines.push(`  ${canvasLink(canvas.id)}`);
  return lines;
}

/** The questions Ponzu's agent waits on, as an agent can answer them. */
export function questionLines(questions: QuestionLike[]): string[] {
  if (questions.length === 0) return [];
  const lines = ["Waiting on the person:"];
  for (const question of questions) {
    const payload = (question.payload ?? {}) as Record<string, any>;
    switch (question.kind) {
      case "question":
        for (const asked of payload.questions ?? []) {
          lines.push(
            `  ${question.id} question: ${asked.question}${asked.multiSelect ? " (choose any)" : ""}`,
            ...(asked.options ?? []).map(
              (option: { label: string; description: string }) =>
                `    - ${option.label}${option.description ? `: ${option.description}` : ""}`,
            ),
          );
        }
        break;
      case "plan":
        lines.push(`  ${question.id} plan to approve:`, indent(String(payload.plan ?? ""), 4));
        break;
      case "permission":
        lines.push(
          `  ${question.id} permission: ${payload.title}${payload.description ? ` (${payload.description})` : ""}`,
        );
        break;
      case "secret":
        lines.push(
          `  ${question.id} secret ${payload.name}: only the person can give it, in the Ponzu app.`,
        );
        break;
      case "handoff":
        lines.push(
          `  ${question.id} only the person can do this in their browser: ${payload.title} ${payload.url}`,
        );
        break;
      default:
        lines.push(`  ${question.id} ${question.kind}`);
    }
  }
  return lines;
}

/** The canvas's pages and boards, with ids and links. */
export function docOutline(doc: unknown, canvasId: string): string {
  const pages = (doc as Doc | null)?.pages ?? [];
  if (pages.length === 0) return "No pages yet.";
  const link = canvasLink(canvasId);
  const lines: string[] = [];
  for (const page of pages) {
    lines.push(`Page ${page.id} "${page.name}" ${link}?page=${page.id}`);
    for (const board of page.artboards) {
      const style = (board.root as { style?: Record<string, string> }).style ?? {};
      const size = style.width && style.height ? ` ${style.width}×${style.height}` : "";
      lines.push(`  board ${board.id} "${board.name}"${size} ${link}?artboard=${board.id}`);
    }
    if (page.artboards.length === 0) lines.push("  no boards");
  }
  return lines.join("\n");
}

/** The thread, oldest first, as lines an agent reads. */
export function threadText(items: ThreadItemLike[]): string {
  return items.map(itemText).filter(Boolean).join("\n");
}

function itemText(item: ThreadItemLike): string {
  const p = item.payload as Record<string, any>;
  const at = `[${item.seq}]`;
  switch (item.kind) {
    case "message": {
      const via = p.via?.name ? ` via ${p.via.name}` : "";
      return `${at} ${p.from?.name ?? "Someone"}${via} said:\n${indent(String(p.text ?? ""), 2)}`;
    }
    case "comment": {
      const where = p.artboardName ? ` on "${p.artboardName}" (${p.artboardId})` : "";
      return `${at} ${p.from?.name ?? "Someone"} commented${where} (thread ${p.threadId}):\n${indent(String(p.text ?? ""), 2)}`;
    }
    case "assistant":
      return `${at} Ponzu's agent said${item.streaming ? " (still writing)" : ""}:\n${indent(String(p.text ?? ""), 2)}`;
    case "tool": {
      const turn = p.turn as { ended: string | null; boards: number; files: number } | undefined;
      if (turn) {
        const ended = turn.ended ?? "still working";
        const boards = turn.boards ? `, ${turn.boards} board${turn.boards === 1 ? "" : "s"}` : "";
        const files = turn.files ? `, ${turn.files} file${turn.files === 1 ? "" : "s"}` : "";
        return `${at} Ponzu's agent's turn (${ended}): ${p.label}${boards}${files}`;
      }
      return `${at} Ponzu's agent: ${p.label}`;
    }
    case "notice": {
      const text = noticeText(p);
      return text ? `${at} ${text}` : "";
    }
  }
}

function noticeText(p: Record<string, any>): string {
  switch (p.type) {
    case "question":
      return `Ponzu's agent asked (${p.questionId}): ${p.header}: ${p.text}`;
    case "pull_request":
      return `Pull request #${p.number} ${p.state}: ${p.title} ${p.url}`;
    case "pull_request_linked":
      return `Linked ${p.repository}#${p.number}: ${p.title} (${p.state}) ${p.url}`;
    case "pull_request_agent":
      return `Ponzu's agent ${String(p.action).replaceAll("_", " ")} pull request #${p.number}${p.as ? ` as ${p.as.name}` : ""}`;
    case "error":
      return `Error: ${p.message}`;
    case "stopped":
      return `Stopped${p.by?.name ? ` by ${p.by.name}` : ""}.`;
    case "waking":
    case "resumed":
    case "started":
      return "";
    default:
      return String(p.type ?? "notice");
  }
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}
