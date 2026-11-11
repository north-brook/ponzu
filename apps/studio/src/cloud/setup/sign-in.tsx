import { GithubMark, Slice } from "../ui/marks.tsx";
import { Waiting } from "./step.tsx";

/**
 * Where sign-in stands: nothing yet, the browser open on GitHub (until the person comes back
 * without finishing, which is idle again), or a sign-in that failed.
 */
export type SignInState = "idle" | "waiting" | "failed";

/** Signing in to Ponzu, with GitHub: the mark, one line on what Ponzu is, and the one button. */
export function SignInStep({ state, onContinue }: { state: SignInState; onContinue: () => void }) {
  const waiting = state === "waiting";
  return (
    <div className="absolute inset-0 flex flex-col items-center pt-[230px]">
      <Slice size={72} className="text-ink" />
      <h1 className="m-0 mt-11 font-display font-semibold text-28 text-ink tracking-[-0.02em]">
        Sign in to Ponzu
      </h1>
      <p className="m-0 mt-3.5 max-w-[420px] text-center text-15 text-muted leading-[1.55]">
        Design on a canvas, steer with comments, and ship pull requests to your repos.
      </p>
      <button
        type="button"
        onClick={onContinue}
        disabled={waiting}
        aria-busy={waiting || undefined}
        className="mt-7 inline-flex h-11 cursor-default items-center gap-2.5 rounded-pill bg-github px-5 font-semibold text-14 text-github-ink leading-none shadow-github outline-none transition-colors duration-(--dur-hover) focus-ring not-disabled:hover:bg-github-hover"
      >
        {waiting ? <Waiting size={16} label="Waiting for the browser" /> : <GithubMark size={16} />}
        Continue with GitHub
      </button>
      {state === "failed" ? (
        <p role="alert" className="m-0 mt-3 text-12 text-danger">
          Couldn't sign in. Try again.
        </p>
      ) : null}
    </div>
  );
}
