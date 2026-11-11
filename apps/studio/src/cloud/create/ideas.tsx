import type { Idea } from "../model.ts";

/**
 * Prompts to start from, for the chosen repo: two columns of quiet tiles. Choosing one fills the
 * composer; it never sends. While they are being made nothing shows (onboarding 4.6): the create
 * page leaves their room, and they rise into it once they are there.
 */
export function Ideas({ ideas, onPick }: { ideas: Idea[]; onPick: (idea: Idea) => void }) {
  return (
    <ul aria-label="Ideas" className="rise m-0 grid list-none grid-cols-2 gap-2 p-0">
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
