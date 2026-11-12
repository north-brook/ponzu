import type { CanvasHeadRow } from "@ponzu/client";
import {
  agentActivity,
  previewOf,
  type RailSignal,
  railSignal,
  sandboxLine,
} from "@ponzu/client/model";
import type { CanvasState } from "@ponzu/core";
import { CANVAS_WORDS } from "../copy";

/*
 * What the canvas screen shows of where the canvas is (iPhone design §7 and §16): from the
 * canvas's live head row (the agent) and CloudSource's state (the API). Pure, so bun tests it.
 *
 * - Loading: nothing yet from either; the title's slice turns.
 * - Waking: the sandbox starting for a turn: the title shimmers and says so under it.
 * - Working: the agent at work: its boards ringed, the title shimmering. No line: the rings say it.
 * - Needs you: the agent waiting on a person. The Mac says it; the iPhone shows no count
 *   until Chat comes to the phone (components/canvas-stack.tsx).
 * - Asleep: nothing running (idle, or Claude's limit): the canvas as the API holds it, quiet.
 * - Offline: the last copy, read only, and one line.
 * - Gone: deleted, or no longer the person's to see.
 */

export type CanvasMood =
  | "loading"
  | "waking"
  | "working"
  | "needs_you"
  | "asleep"
  | "offline"
  | "gone";

export interface CanvasStatus {
  mood: CanvasMood;
  /** One quiet line under the title, or none. */
  line: string | null;
  /** The title shimmers: the agent is getting to work, or at it. */
  busy: boolean;
  /** The boards that get the ring. */
  working: string[];
  /** What the Chat button shows (the shared rule the Mac's thread toggle follows). */
  chat: RailSignal;
}

type Head = Pick<
  CanvasHeadRow,
  "agentState" | "agentStatus" | "agentArtboards" | "agentBlocker" | "needsYouCount"
>;

export function canvasStatus(
  head: Head | undefined,
  source: Pick<CanvasState, "status" | "doc">,
): CanvasStatus {
  const chat: RailSignal = head
    ? railSignal({ needsYou: head.needsYouCount, agentState: head.agentState }, false)
    : "idle";
  if (source.status === "error") {
    return { mood: "gone", line: CANVAS_WORDS.gone, busy: false, working: [], chat: "idle" };
  }
  if (source.status === "offline") {
    // The head is as old as the last copy: no ring that may have ended long ago.
    const line = source.doc ? CANVAS_WORDS.offline : CANVAS_WORDS.unreachable;
    return { mood: "offline", line, busy: false, working: [], chat };
  }
  if (!head) {
    return { mood: "loading", line: null, busy: false, working: [], chat };
  }
  const machine = sandboxLine(agentActivity(head))?.text ?? null;
  switch (head.agentState) {
    case "waking":
      return {
        mood: "waking",
        line: machine ?? CANVAS_WORDS.waking,
        busy: true,
        working: [],
        chat,
      };
    case "working":
      return { mood: "working", line: null, busy: true, working: head.agentArtboards, chat };
    case "needs_you":
      return { mood: "needs_you", line: null, busy: false, working: [], chat };
    case "idle":
    case "limited":
      return { mood: "asleep", line: machine, busy: false, working: [], chat };
  }
}

/** The canvas's first-page preview in this theme, as the runner drew it; null before it has. */
export function previewUrl(
  view: { assetsUrl: string; previewSeq: number | null } | undefined,
  theme: "light" | "dark",
): string | null {
  return view ? (previewOf(view.assetsUrl, view.previewSeq)?.[theme] ?? null) : null;
}
