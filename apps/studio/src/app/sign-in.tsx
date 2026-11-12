import { useEffect, useRef, useState } from "react";
import { type SignInCopy, type SignInState, SignInStep } from "../cloud/setup/sign-in.tsx";
import { useAnalytics } from "./analytics/provider.tsx";
import type { Host } from "./host.ts";

/*
 * 1 · Sign in (spec: onboarding 4.1). GitHub is only the method: one button, and the browser
 * does the rest. A press starts a sign-in in the browser, and the button waits with the grey
 * turning slice in place of GitHub's mark for a short cooldown (`cooldown` below), then is
 * ready again, for someone whose tab went missing. Nothing here ends a sign-in: each one the
 * shell started can still finish in its tab, whatever this window does, and the first to finish
 * signs the person in. A sign-in that failed says why in one line under the button, in the
 * shell's words.
 */

export type SignInReason = "signed_out" | "github_reauth";

const COPY: Record<SignInReason, SignInCopy | undefined> = {
  signed_out: undefined,
  github_reauth: {
    title: "Sign in again",
    body: "GitHub needs you to let Ponzu in again. Your canvases are all still here.",
  },
};

/** Never ready again sooner than this after a press: the browser takes a moment to open. */
export const COOLDOWN_MS = 4_000;
/** Back in the window from the browser: ready again this long after, not at once. */
export const BACK_MS = 1_500;

/**
 * Waits out the cooldown after a press, then calls `ready`: at least COOLDOWN_MS, and if the
 * window is in the background then (the browser took the focus), until BACK_MS after it is
 * back. A browser that opened behind the window leaves it focused: ready at COOLDOWN_MS.
 * Returns a function that stops waiting.
 */
export function cooldown(
  ready: () => void,
  target: Pick<
    Window,
    "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"
  > & { document: Pick<Document, "hasFocus"> } = window,
): () => void {
  let timer: number | undefined;
  const back = () => {
    target.clearTimeout(timer);
    timer = target.setTimeout(ready, BACK_MS);
  };
  timer = target.setTimeout(() => {
    if (target.document.hasFocus()) ready();
    else target.addEventListener("focus", back);
  }, COOLDOWN_MS);
  return () => {
    target.clearTimeout(timer);
    target.removeEventListener("focus", back);
  };
}

export function SignInScreen({ host, reason }: { host: Host; reason: SignInReason }) {
  const [state, setState] = useState<SignInState>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  const analytics = useAnalytics();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The cooldown after a press: then the button is ready again, the sign-in still waiting.
  useEffect(() => {
    if (state !== "waiting") return;
    return cooldown(() => setState("idle"));
  }, [state]);

  const signIn = async () => {
    if (state === "waiting") return;
    setState("waiting");
    setFailure(null);
    analytics.capture("sign in started");
    const result = await host.signIn();
    if (result.ok) analytics.capture("sign in completed");
    else if (result.reason === "failed")
      analytics.capture("sign in failed", { reason: result.code });
    else analytics.capture("sign in cancelled");
    if (!mounted.current) return;
    // A sign-in that ended quietly (another finished, it ran out) changes nothing here.
    if (!result.ok && result.reason === "failed") {
      setFailure(result.message);
      setState("failed");
    }
  };

  const copy = COPY[reason];
  return (
    <SignInStep state={state} onContinue={signIn} failure={failure} {...(copy ? { copy } : {})} />
  );
}
