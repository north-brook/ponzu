import { describe, expect, test } from "bun:test";
import { ApiError, type ClientErrorCode } from "../errors.ts";
import {
  afterInput,
  afterRefusal,
  afterStartFailed,
  CHOOSING,
  CLAUDE_LIMITED,
  type ClaudeEntry,
  canConnect,
  entryError,
  signInSpent,
} from "./claude-entry.ts";

const code = (
  text: string,
  status: Extract<ClaudeEntry, { mode: "subscription" }>["status"] = "idle",
) => ({ mode: "subscription", code: text, status }) as const;
const key = (text: string) => ({ mode: "api_key", key: text, status: "idle" }) as const;

describe("connecting Claude, as the Mac and the phone both say it", () => {
  test("each refusal from the API, in words", () => {
    const refused = (entry: ClaudeEntry, apiCode: ClientErrorCode, status = 400) =>
      entryError(afterRefusal(entry, new ApiError(status, apiCode, "No.")));
    expect(refused(key("sk-ant-x"), "claude_key_invalid")).toBe(
      "Anthropic didn't accept that key.",
    );
    expect(refused(code("k7"), "claude_code_invalid")).toBe(
      "That code isn't complete. Copy all of it.",
    );
    expect(refused(code("k7#s"), "claude_code_invalid")).toBe("That code didn't work.");
    expect(refused(code("k7#s"), "claude_sign_in_used", 409)).toBe("That sign-in has been used.");
    expect(refused(code("k7#s"), "claude_sign_in_expired", 410)).toBe("That code has expired.");
    expect(refused(code("k7#s"), "network", 0)).toBe("Couldn't reach Claude. Try again.");
  });

  test("a spent sign-in can't connect until a new one opens; typing fixes only what it can", () => {
    const wrong = afterRefusal(code("k7#s"), new ApiError(400, "claude_code_invalid", "No."));
    expect(signInSpent(wrong)).toBe(true);
    expect(canConnect(afterInput(wrong, "other#code"))).toBe(false);
    const incomplete = afterRefusal(code("k7"), new ApiError(400, "claude_code_invalid", "No."));
    expect(canConnect(afterInput(incomplete, "k7#s"))).toBe(true);
    expect(canConnect(code("  "))).toBe(false);
    expect(canConnect(code("k7#s", "connecting"))).toBe(false);
    expect(canConnect(CHOOSING)).toBe(false);
    // A key loses the spaces a copy brings with it.
    expect(afterInput(key(""), " sk-ant-\nabc ")).toEqual(key("sk-ant-abc"));
  });

  test("too many sign-ins this hour says so; anything else that stops a start is unreachable", () => {
    const limited = new ApiError(429, "rate_limited", "Slow down.");
    expect(afterStartFailed(CHOOSING, limited)).toEqual({
      mode: "choose",
      starting: false,
      failed: false,
      limited: true,
    });
    const reopened = afterStartFailed(code("x#y"), limited);
    expect(reopened.mode === "subscription" && entryError(reopened)).toBe(CLAUDE_LIMITED);
    expect(afterStartFailed(CHOOSING, new Error("offline"))).toMatchObject({ failed: true });
  });
});
