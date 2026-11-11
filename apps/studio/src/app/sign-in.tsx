import { useEffect, useRef, useState } from "react";
import { type SignInCopy, type SignInState, SignInStep } from "../cloud/setup/sign-in.tsx";
import type { Host } from "./host.ts";

/*
 * 1 · Sign in (spec: onboarding 4.1). GitHub is only the method: one button, and the browser
 * does the rest. While the browser is out the button waits with the grey turning slice in place
 * of GitHub's mark; someone who comes back to the window without finishing finds it ready
 * again (or presses Cancel, for a browser that opened without taking the window's focus), and
 * a sign-in that failed says why in one line under it, in the shell's words.
 */

export type SignInReason = "signed_out" | "github_reauth";

const COPY: Record<SignInReason, SignInCopy | undefined> = {
  signed_out: undefined,
  github_reauth: {
    title: "Sign in again",
    body: "GitHub needs you to let Ponzu in again. Your designs are all still here.",
  },
};

/**
 * Back in the window while the browser is out: give it this long to finish first, since a
 * sign-in that completes brings the window forward itself.
 */
const RETURN_GRACE_MS = 1_500;

export function SignInScreen({ host, reason }: { host: Host; reason: SignInReason }) {
  const [state, setState] = useState<SignInState>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      host.cancelSignIn();
    };
  }, [host]);

  // Came back without finishing: the button is ready again.
  useEffect(() => {
    if (state !== "waiting") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const back = () => {
      clearTimeout(timer);
      timer = setTimeout(() => host.cancelSignIn(), RETURN_GRACE_MS);
    };
    window.addEventListener("focus", back);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", back);
    };
  }, [host, state]);

  const signIn = async () => {
    setState("waiting");
    setFailure(null);
    const result = await host.signIn();
    if (!mounted.current) return;
    if (!result.ok && result.reason === "failed") {
      setFailure(result.message);
      setState("failed");
    } else {
      setState("idle");
    }
  };

  const copy = COPY[reason];
  return (
    <SignInStep
      state={state}
      onContinue={signIn}
      onCancel={() => host.cancelSignIn()}
      failure={failure}
      {...(copy ? { copy } : {})}
    />
  );
}
