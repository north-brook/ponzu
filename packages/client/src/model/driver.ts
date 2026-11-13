/*
 * A person's own agent driving a canvas in place of Ponzu's (docs/cloud.md, "Your own agent"),
 * as the Mac and the phone both say it: the rail toggle's or chat button's words while it
 * drives, the thread's line when it takes or lets go, and which mark an agent gets.
 */
import type { CanvasDriver } from "../live/rows.ts";
import { firstName, type ThreadNotice } from "./model.ts";
import { who } from "./thread.ts";
import { clock } from "./time.ts";

/** The marks `AgentMark` draws. Codex is OpenAI's. */
export type AgentClient = "claude" | "openai" | "cursor" | "t3" | "other";

/**
 * Which mark an agent gets from what it said it is: a grant's `client` as its MCP `initialize`
 * gave it (`claude-code/2.1.0`, `codex-mcp-client`, `cursor-vscode`), or a driver's own `client`.
 */
export function agentClientOf(client: string | null | undefined): AgentClient {
  const said = (client ?? "").trim().toLowerCase();
  if (said.startsWith("claude")) return "claude";
  if (said.startsWith("codex") || said.startsWith("openai")) return "openai";
  if (said.startsWith("cursor")) return "cursor";
  if (/^t3(?:$|code|[\s/_-])/.test(said)) return "t3";
  return "other";
}

/** "Claude Code is driving this canvas": the tooltip's and the popover's first line. */
export function drivingTitle(driver: Pick<CanvasDriver, "name">): string {
  return `${driver.name} is driving this canvas`;
}

/**
 * The second line: "In T3 Code · since 4:00 PM · your comments go to it". Without a host it
 * starts at "Since". A drive begun another day says the day.
 */
export function drivingLine(driver: Pick<CanvasDriver, "host" | "since">, now: number): string {
  const parts = [
    ...(driver.host ? [`In ${driver.host}`] : []),
    ...(driver.since ? [`since ${sinceWhen(driver.since, now)}`] : []),
    "your comments go to it",
  ];
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** A time today as the clock says it ("4:00 PM"); another day's as its date ("Nov 12"). */
export function sinceWhen(at: string, now: number): string {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return "";
  return then.toDateString() === new Date(now).toDateString()
    ? clock(at)
    : then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** How long a drive lasts without a call before it lapses (the API's lease). */
export const DRIVE_LAPSE_MINUTES = 30;

/**
 * The thread's quiet line for a `driver` notice: "Claude Code is driving this canvas (in T3
 * Code)", "Claude Code let go of the canvas", "Maya took the canvas back", "Claude Code's turn
 * ran out after 30 minutes without a call", "Claude Code was disconnected".
 */
export function driverNoticeLine(
  notice: Extract<ThreadNotice, { type: "driver" }>,
  meId: string,
): string {
  const agent = notice.agent || "Your agent";
  switch (notice.action) {
    case "took":
      return `${agent} is driving this canvas${notice.host ? ` (in ${notice.host})` : ""}`;
    case "let_go":
      return `${agent} let go of the canvas`;
    case "taken_back":
      return notice.by
        ? `${who(notice.by, meId)} took the canvas back`
        : `The canvas was taken back from ${agent}`;
    case "lapsed":
      return `${agent}'s turn ran out after ${DRIVE_LAPSE_MINUTES} minutes without a call`;
    case "revoked":
      return notice.owner && notice.owner.id !== meId
        ? `${agent} was disconnected by ${firstName(notice.owner)}`
        : `${agent} was disconnected`;
    default:
      return `${agent} stopped driving the canvas`;
  }
}

/** Taking the canvas back, asked first: the dialog's words. */
export function takeBackWords(driver: Pick<CanvasDriver, "name">) {
  return {
    title: `Take the canvas back from ${driver.name}?`,
    body: `${driver.name} stops driving it and Ponzu's agent picks up what people sent meanwhile. It can take the canvas again later.`,
    confirm: "Take back",
    cancel: "Cancel",
  } as const;
}
