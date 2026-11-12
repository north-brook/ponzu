/*
 * Connecting the person's Claude, as its card stands: choosing a way, pasting the code claude.ai
 * shows after a sign-in, or entering an Anthropic API key. The Mac's Claude card and the phone's
 * Connect Claude screens both draw these states and say these words, so the two agree exactly.
 */
import { ApiError } from "../errors.ts";
import { enteredKey } from "./claude.ts";

export type ClaudeCardState =
  | {
      mode: "choose";
      /** Asking for a claude.ai sign-in: Sign in waits until its address is ready. */
      starting: boolean;
      /** The sign-in couldn't be started. */
      failed: boolean;
      /** Claude turned the start away: the person has started too many this hour. */
      limited?: boolean;
    }
  | {
      mode: "subscription";
      code: string;
      /**
       * `incomplete`: not the whole code, so it can be pasted again. `wrong`: claude.ai turned it
       * away. `used`, `expired`: the sign-in is spent. Past each of those three only Open
       * sign-in again helps. `limited`: too many sign-ins this hour, so even that waits. `failed`:
       * Claude couldn't be reached.
       */
      status:
        | "idle"
        | "connecting"
        | "incomplete"
        | "wrong"
        | "used"
        | "expired"
        | "limited"
        | "failed";
    }
  | {
      mode: "api_key";
      key: string;
      status: "idle" | "connecting" | "rejected" | "failed";
    };

/** A way being entered: the code or the key. */
export type ClaudeEntry = Exclude<ClaudeCardState, { mode: "choose" }>;

export const CHOOSING: ClaudeCardState = { mode: "choose", starting: false, failed: false };

/** As the API says it when a person has started too many sign-ins in an hour. */
export const CLAUDE_LIMITED =
  "You've started signing in to Claude several times this hour. Try again later.";

/** When a sign-in couldn't be started, or Claude couldn't be reached. */
export const CLAUDE_UNREACHABLE = "Couldn't reach Claude. Try again.";

/**
 * What each failure says, in place of the field's helper. For a code, Open sign-in again
 * follows it, which is the way on from each.
 */
export const CLAUDE_ENTRY_ERRORS: Partial<Record<ClaudeEntry["status"], string>> = {
  incomplete: "That code isn't complete. Copy all of it.",
  wrong: "That code didn't work.",
  used: "That sign-in has been used.",
  expired: "That code has expired.",
  limited: CLAUDE_LIMITED,
  rejected: "Anthropic didn't accept that key.",
  failed: CLAUDE_UNREACHABLE,
};

/** The failure an entry shows, or null while it has none. */
export function entryError(state: ClaudeEntry): string | null {
  return CLAUDE_ENTRY_ERRORS[state.status] ?? null;
}

/** A sign-in that can take no more codes: only a new one helps. */
export function signInSpent(state: ClaudeCardState): boolean {
  return (
    state.mode === "subscription" &&
    (state.status === "wrong" ||
      state.status === "used" ||
      state.status === "expired" ||
      state.status === "limited")
  );
}

/** Whether Connect can send what was entered. */
export function canConnect(state: ClaudeCardState): boolean {
  if (state.mode === "choose" || state.status === "connecting" || signInSpent(state)) return false;
  return (state.mode === "subscription" ? state.code : state.key).trim().length > 0;
}

/** What the card says after the API turned an entry down, by the API's code. */
export function afterRefusal(state: ClaudeEntry, error: unknown): ClaudeEntry {
  const code = error instanceof ApiError ? error.code : null;
  if (state.mode === "api_key") {
    const rejected = code === "claude_key_invalid" || code === "invalid_request";
    return { ...state, status: rejected ? "rejected" : "failed" };
  }
  if (code === "claude_code_invalid") {
    // A code without its second half never reaches claude.ai: the sign-in can take it again.
    const whole = state.code.includes("#");
    return { ...state, status: whole ? "wrong" : "incomplete" };
  }
  if (code === "claude_sign_in_used" || code === "not_found") return { ...state, status: "used" };
  if (code === "claude_sign_in_expired") return { ...state, code: "", status: "expired" };
  return { ...state, status: "failed" };
}

/** What the card says when a sign-in couldn't be started, by where it was asked from. */
export function afterStartFailed(from: ClaudeCardState, error: unknown): ClaudeCardState {
  // Each sign-in is a machine Ponzu pays for, so the API starts only so many an hour.
  const limited = error instanceof ApiError && error.code === "rate_limited";
  if (from.mode === "choose") return { mode: "choose", starting: false, failed: !limited, limited };
  return { mode: "subscription", code: "", status: limited ? "limited" : "failed" };
}

/** Typing clears a mistake that typing can fix; a spent sign-in stays spent until reopened. */
export function afterInput(state: ClaudeEntry, text: string): ClaudeEntry {
  if (state.mode === "api_key") return { ...state, key: enteredKey(text), status: "idle" };
  const fixable = state.status === "incomplete" || state.status === "failed";
  return { ...state, code: text, status: fixable ? "idle" : state.status };
}
