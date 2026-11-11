import { ApiError } from "@ponzu/client";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { enteredKey } from "../../cloud/claude.ts";
import type { ClaudeCardProps, ClaudeCardState } from "../../cloud/setup/claude-card.tsx";
import { usePonzu } from "../ponzu-query.tsx";

/*
 * Connecting the person's Claude, as the Claude card shows it (cloud/setup/claude-card.tsx):
 * guided setup's step, Settings › Agents and the dialog a send opens all use this one. Either
 * a claude.ai sign-in (started here, opened in the browser, finished with the code claude.ai
 * shows, within ten minutes and for one code) or an Anthropic API key.
 */

type Entry = Exclude<ClaudeCardState, { mode: "choose" }>;

export const CHOOSING: ClaudeCardState = { mode: "choose", starting: false, failed: false };

/** A sign-in started and not yet finished: what the code goes to, and until when. */
interface PendingSignIn {
  id: string;
  expiresAt: string;
}

/** What the card says after the API turned an entry down, by the API's code. */
export function afterRefusal(state: Entry, error: unknown): Entry {
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

/** Typing clears a mistake that typing can fix; a spent sign-in stays spent until reopened. */
export function afterInput(state: Entry, text: string): Entry {
  if (state.mode === "api_key") return { ...state, key: enteredKey(text), status: "idle" };
  const fixable = state.status === "incomplete" || state.status === "failed";
  return { ...state, code: text, status: fixable ? "idle" : state.status };
}

/**
 * The Claude card, live. `onConnected` runs once the API has the person's Claude; the cache's
 * `me` and Claude answers already say so by then. Starting on the code field starts a claude.ai
 * sign-in at once: the person asked to sign in.
 */
export function useClaudeConnect({
  openExternal,
  onConnected,
  initial = CHOOSING,
}: {
  openExternal: (url: string) => void;
  onConnected?: () => void;
  initial?: ClaudeCardState;
}): ClaudeCardProps {
  const { mutations } = usePonzu();
  const [state, setState] = useState<ClaudeCardState>(initial);
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const start = useMutation(mutations.startClaudeSignIn());
  const sendCode = useMutation(mutations.sendClaudeCode());
  const connectKey = useMutation(mutations.connectApiKey());
  const abandon = useMutation(mutations.abandonClaudeSignIn());
  const connected = useRef(onConnected);
  connected.current = onConnected;
  const startedAtOnce = useRef(false);

  // Ten minutes after it began, a sign-in takes no code: say so before the person tries one.
  useEffect(() => {
    if (!pending) return;
    const left = Date.parse(pending.expiresAt) - Date.now();
    const timer = setTimeout(
      () =>
        setState((now) =>
          now.mode === "subscription" && now.status !== "connecting"
            ? { ...now, code: "", status: "expired" }
            : now,
        ),
      Math.max(0, left),
    );
    return () => clearTimeout(timer);
  }, [pending]);

  // A new sign-in replaces the one before it, at the API.
  const signIn = (from: ClaudeCardState) => {
    if (from.mode === "choose") setState({ ...from, starting: true, failed: false });
    start.mutate(undefined, {
      onSuccess: ({ id, authorizeUrl, expiresAt }) => {
        setPending({ id, expiresAt });
        setState({ mode: "subscription", code: "", status: "idle" });
        openExternal(authorizeUrl);
      },
      onError: () =>
        setState(
          from.mode === "choose"
            ? { mode: "choose", starting: false, failed: true }
            : { mode: "subscription", code: "", status: "failed" },
        ),
    });
  };

  useEffect(() => {
    if (initial.mode !== "subscription" || startedAtOnce.current) return;
    startedAtOnce.current = true;
    signIn(initial);
  });

  return {
    state,
    onSignIn: () => signIn(state),
    onAddKey: () => setState({ mode: "api_key", key: "", status: "idle" }),
    onChange: () => {
      if (pending) abandon.mutate(pending.id);
      setPending(null);
      setState(CHOOSING);
    },
    onInput: (text) => setState((now) => (now.mode === "choose" ? now : afterInput(now, text))),
    onReopen: () => signIn(state),
    onSubmit: () => {
      if (state.mode === "choose") return;
      const entry = state;
      setState({ ...entry, status: "connecting" } as Entry);
      const done = {
        onSuccess: () => {
          setPending(null);
          connected.current?.();
        },
        onError: (error: unknown) => setState(afterRefusal(entry, error)),
      };
      if (entry.mode === "api_key") {
        connectKey.mutate(entry.key, done);
      } else if (pending) {
        sendCode.mutate({ signInId: pending.id, code: entry.code.trim() }, done);
      } else {
        setState({ ...entry, status: "expired", code: "" });
      }
    },
  };
}
