import {
  afterInput,
  afterRefusal,
  afterStartFailed,
  CHOOSING,
  type ClaudeEntry,
} from "@ponzu/client/model/claude-entry";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ClaudeCardProps,
  type ClaudeCardState,
  signInSpent,
} from "../../cloud/setup/claude-card.tsx";
import { usePonzu } from "../ponzu-query.tsx";

/*
 * Connecting the person's Claude, as the Claude card shows it (cloud/setup/claude-card.tsx):
 * guided setup's step, Settings › Agents and the dialog a send opens all use this one. Either
 * a claude.ai sign-in (started here, opened in the browser, finished with the code claude.ai
 * shows, within ten minutes and for one code) or an Anthropic API key.
 */

type Entry = ClaudeEntry;

// The card's states as they move are shared with the phone (@ponzu/client/model/claude-entry).
export { afterInput, afterRefusal, afterStartFailed, CHOOSING };

/** A sign-in started and not yet finished: what the code goes to, and until when. */
interface PendingSignIn {
  id: string;
  expiresAt: string;
}

/** The card's own props, and the way straight to the code field a Settings row takes. */
export interface ClaudeConnect extends ClaudeCardProps {
  /** Start a claude.ai sign-in from a press elsewhere, with the card on the code field. */
  openSubscription: () => void;
}

/**
 * The Claude card, live. `onConnected` runs once the API has the person's Claude; the cache's
 * `me` and Claude answers already say so by then, and the card is back on its two ways with
 * nothing entered kept. With `leavesWhenConnected` (guided setup, which moves on to the next
 * step) it stays on Connecting instead until it goes, rather than showing its two ways again
 * for the moment before the next step is drawn: what was entered goes with the card, and its
 * mutation keeps nothing all the same.
 *
 * Each sign-in is a sandbox the API runs until it is used or let go of, and counts toward the
 * person's sign-ins this hour. So one starts only on a press, never two at once, and is let go
 * of when the person leaves it: Change, or the card going away (the step moving on, Settings
 * or a dialog closing). The answer to a start the person has since left is let go of too.
 */
export function useClaudeConnect({
  openExternal,
  onConnected,
  leavesWhenConnected = false,
}: {
  openExternal: (url: string) => void;
  onConnected?: () => void;
  leavesWhenConnected?: boolean;
}): ClaudeConnect {
  const { api, mutations } = usePonzu();
  const [state, setState] = useState<ClaudeCardState>(CHOOSING);
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const start = useMutation(mutations.startClaudeSignIn());
  const sendCode = useMutation(mutations.sendClaudeCode());
  const connectKey = useMutation(mutations.connectApiKey());
  const connected = useRef(onConnected);
  connected.current = onConnected;
  /** The sign-in open at the API that this card holds, until it is used or let go of. */
  const held = useRef<string | null>(null);
  /** Counts starts and leavings: only the answer to the latest start is taken. */
  const latest = useRef(0);
  /** A start is on its way: presses wait for it, since each one is another sandbox. */
  const starting = useRef(false);

  const letGo = useCallback(
    (id: string) => {
      // Nothing waits on it: if it doesn't arrive, the API's sweep ends the sign-in.
      api.claude.abandonSignIn(id).catch(() => {});
    },
    [api],
  );
  const leave = useCallback(() => {
    latest.current += 1;
    if (held.current) letGo(held.current);
    held.current = null;
  }, [letGo]);
  useEffect(() => leave, [leave]);

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
    if (starting.current) return;
    starting.current = true;
    const ticket = ++latest.current;
    if (from.mode === "choose") setState({ mode: "choose", starting: true, failed: false });
    start
      .mutateAsync()
      .finally(() => {
        starting.current = false;
      })
      .then(
        ({ id, authorizeUrl, expiresAt }) => {
          if (ticket !== latest.current) return letGo(id);
          held.current = id;
          setPending({ id, expiresAt });
          setState({ mode: "subscription", code: "", status: "idle" });
          openExternal(authorizeUrl);
        },
        (error: unknown) => {
          if (ticket === latest.current) setState(afterStartFailed(from, error));
        },
      );
  };

  return {
    state,
    onSignIn: () => signIn(state),
    onAddKey: () => setState({ mode: "api_key", key: "", status: "idle" }),
    onChange: () => {
      leave();
      setPending(null);
      setState(CHOOSING);
    },
    onInput: (text) => setState((now) => (now.mode === "choose" ? now : afterInput(now, text))),
    onReopen: () => signIn(state),
    reopening: start.isPending && state.mode === "subscription",
    openSubscription: () => {
      const entry: ClaudeCardState = { mode: "subscription", code: "", status: "idle" };
      setState(entry);
      signIn(entry);
    },
    onSubmit: () => {
      if (state.mode === "choose") return;
      const entry = state;
      setState({ ...entry, status: "connecting" } as Entry);
      // A code on its way is the sign-in's to settle: taken, it has nothing left to let go of,
      // and the card can go (the step moving on as `me` says Claude is connected) before this
      // hears back. It is held again only if it can still take a code.
      const sending = held.current;
      if (entry.mode === "subscription") held.current = null;
      // The answer is heard whether or not the card is still here (`mutateAsync`, not the
      // per-call callbacks React Query drops once the card unmounts): a card left since
      // (Change, or the card going away) lets go of a sign-in its code failed to use.
      const ticket = latest.current;
      const left = () => ticket !== latest.current;
      const onSuccess = () => {
        if (left()) return;
        setPending(null);
        // Nothing of the key or code stays in the card, or its mutation, once it is sent.
        if (!leavesWhenConnected) setState(CHOOSING);
        connectKey.reset();
        sendCode.reset();
        connected.current?.();
      };
      const onError = (error: unknown) => {
        const next = afterRefusal(entry, error);
        // A sign-in that took its one code, or ran out, has nothing left to let go of.
        if (entry.mode === "subscription" && sending && !signInSpent(next)) {
          if (left()) return letGo(sending);
          held.current = sending;
        }
        if (!left()) setState(next);
      };
      if (entry.mode === "api_key") {
        connectKey.mutateAsync(entry.key).then(onSuccess, onError);
      } else if (pending) {
        sendCode
          .mutateAsync({ signInId: pending.id, code: entry.code.trim() })
          .then(onSuccess, onError);
      } else {
        setState({ ...entry, status: "expired", code: "" });
      }
    },
  };
}
