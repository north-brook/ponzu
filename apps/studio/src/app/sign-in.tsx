import { useEffect, useRef, useState } from "react";
import { cn } from "../cloud/ui/cn.ts";
import { GithubMark, Slice } from "../cloud/ui/marks.tsx";
import type { Host } from "./host.ts";

/*
 * 1 · Sign in (spec: onboarding 4.1). GitHub is only the method: one button, and the browser
 * does the rest. While the browser is out the button waits with the grey turning slice in place
 * of GitHub's mark; a sign-in that didn't finish says so in one line under it.
 */

export type SignInReason = "signed_out" | "github_reauth";

const COPY: Record<SignInReason, { title: string; body: string }> = {
  signed_out: {
    title: "Sign in to Ponzu",
    body: "Design on a canvas, steer with comments, and ship pull requests to your repos.",
  },
  github_reauth: {
    title: "Sign in again",
    body: "GitHub needs you to let Ponzu in again. Your designs are all still here.",
  },
};

export function SignInScreen({ host, reason }: { host: Host; reason: SignInReason }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      host.cancelSignIn();
    };
  }, [host]);

  const signIn = async () => {
    setError(null);
    setWaiting(true);
    const result = await host.signIn();
    if (!mounted.current) return;
    setWaiting(false);
    if (!result.ok && result.reason === "failed") setError(result.message);
  };

  const { title, body } = COPY[reason];
  return (
    <div
      data-screen="sign-in"
      className="absolute inset-0 flex flex-col items-center overflow-y-auto pt-[230px]"
    >
      <Slice size={72} className="text-ink" />
      <h1 className="m-0 mt-11 font-display font-semibold text-[28px] text-ink tracking-[-0.02em]">
        {title}
      </h1>
      <p className="m-0 mt-3.5 max-w-[420px] text-center text-[15px] text-muted leading-[1.55]">
        {body}
      </p>
      <button
        type="button"
        onClick={signIn}
        disabled={waiting}
        className={cn(
          "app-no-drag mt-7 flex h-11 cursor-default items-center gap-2.5 rounded-pill bg-action px-5 font-semibold text-14 text-action-ink outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-action-hover active:bg-action-press",
          waiting && "pointer-events-none",
        )}
      >
        {waiting ? (
          <Slice size={16} turning label="Waiting for your browser" className="text-dry" />
        ) : (
          <GithubMark size={16} />
        )}
        Continue with GitHub
      </button>
      {waiting ? (
        <p className="m-0 mt-3 flex items-center gap-1 text-12 text-faint">
          Finish signing in in your browser.
          <button
            type="button"
            onClick={() => host.cancelSignIn()}
            className="app-no-drag cursor-default rounded-4 px-1 text-muted underline-offset-2 outline-none focus-ring hover:underline"
          >
            Cancel
          </button>
        </p>
      ) : error ? (
        <p role="alert" className="m-0 mt-3 text-12 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
