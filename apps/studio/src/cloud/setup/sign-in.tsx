import { GithubMark, Slice } from "../ui/marks.tsx";
import { Waiting } from "./step.tsx";

/**
 * Where sign-in stands: nothing yet, just pressed (the browser opening on GitHub, for a short
 * cooldown, after which it is idle again with the sign-in still able to finish in its tab), or
 * a sign-in that failed.
 */
export type SignInState = "idle" | "waiting" | "failed";

/** The words over the button: signing in, or signing in again when GitHub wants Ponzu let in again. */
export interface SignInCopy {
  title: string;
  body: string;
}

const SIGN_IN: SignInCopy = {
  title: "Sign in to Ponzu",
  body: "Build on a canvas, steer with comments, and ship pull requests to your repos.",
};

/** Signing in to Ponzu, with GitHub: the mark, one line on what Ponzu is, and the one button. */
export function SignInStep({
  state,
  onContinue,
  failure,
  copy = SIGN_IN,
}: {
  state: SignInState;
  /** Not called while waiting: a press in the cooldown does nothing. */
  onContinue: () => void;
  /** Why it failed, in the shell's words; the spec's line when there are none. */
  failure?: string | null;
  copy?: SignInCopy;
}) {
  const waiting = state === "waiting";
  return (
    <div data-screen="sign-in" className="absolute inset-0 flex flex-col items-center pt-[230px]">
      <Slice size={72} className="text-ink" />
      <h1 className="m-0 mt-11 font-display font-semibold text-28 text-ink tracking-[-0.02em]">
        {copy.title}
      </h1>
      <p className="m-0 mt-3.5 max-w-[420px] text-center text-15 text-muted leading-[1.55]">
        {copy.body}
      </p>
      <button
        type="button"
        onClick={waiting ? undefined : onContinue}
        disabled={waiting}
        aria-busy={waiting || undefined}
        className="mt-7 inline-flex h-11 cursor-default items-center gap-2.5 rounded-pill bg-github px-5 font-semibold text-14 text-github-ink leading-none shadow-github outline-none transition-colors duration-(--dur-hover) focus-ring not-disabled:hover:bg-github-hover"
      >
        {waiting ? <Waiting size={16} label="Waiting for the browser" /> : <GithubMark size={16} />}
        Continue with GitHub
      </button>
      {state === "failed" ? (
        <p role="alert" className="m-0 mt-3 max-w-[420px] text-center text-12 text-danger">
          {failure || "Couldn't sign in. Try again."}
        </p>
      ) : null}
    </div>
  );
}
