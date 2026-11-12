/*
 * The home page's four steps, from a sentence to a merge: what happens, in the order it happens,
 * in the app's own words (site design §3.1; the overview board's steps, Describe it to Merge).
 */

export const STEPS = [
  {
    title: "Describe it.",
    body: "Pick a repo, or Scratch, and say what you want. Ideas from your repo are a tap away.",
  },
  {
    title: "Claude sets it up.",
    body: "Its own sandbox and branch, from your default branch. The first boards arrive in seconds.",
  },
  {
    title: "Steer with comments.",
    body: "Pin a comment on anything. Ponzu makes the change and answers in the thread.",
  },
  {
    title: "Ship it.",
    body: "Commits land on the branch as it works. Open the pull request, watch the checks, merge with one button.",
  },
] as const;

export function Steps() {
  return (
    <ol className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map((step, i) => (
        <li key={step.title} className="flex flex-col gap-3 rounded-3xl bg-tile p-6 sm:p-7">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-full bg-yuzu font-mono text-[13px] font-medium text-[#111110]"
          >
            {i + 1}
          </span>
          <h3 className="m-0 font-display text-[22px]/[28px] font-semibold tracking-[-0.02em] text-ink">
            {step.title}
          </h3>
          <p className="m-0 text-[15px]/[24px] text-pretty text-muted">{step.body}</p>
        </li>
      ))}
    </ol>
  );
}
