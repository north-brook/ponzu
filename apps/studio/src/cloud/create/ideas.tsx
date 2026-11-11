import type { Idea } from "../model.ts";

/**
 * Prompts to start from, for the chosen repo: two columns of quiet tiles. Choosing one fills the
 * composer; it never sends. `ideas` "loading" holds their places while the repo is read.
 */
export function Ideas({
  ideas,
  onPick,
}: {
  ideas: Idea[] | "loading";
  onPick: (idea: Idea) => void;
}) {
  if (ideas === "loading") {
    return (
      <div role="status" aria-label="Finding ideas" className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="breathe flex h-[58px] flex-col gap-2 rounded-10 px-[13px] py-[13px] shadow-[inset_0_0_0_1px_var(--c-rule)]"
            style={{ animationDelay: `${i * 120}ms` }}
          >
            <span className="h-2.5 w-4/5 rounded-3 bg-hover" />
            <span className="h-2.5 w-1/2 rounded-3 bg-hover" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <ul aria-label="Ideas" className="m-0 grid list-none grid-cols-2 gap-2 p-0">
      {ideas.map((idea) => (
        <li key={idea.id} className="flex">
          <button
            type="button"
            onClick={() => onPick(idea)}
            className="flex flex-1 cursor-default rounded-10 px-[13px] py-[11px] text-left text-13 text-muted leading-[1.4] shadow-[inset_0_0_0_1px_var(--c-rule)] outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover hover:text-ink active:bg-press"
          >
            {idea.prompt}
          </button>
        </li>
      ))}
    </ul>
  );
}
