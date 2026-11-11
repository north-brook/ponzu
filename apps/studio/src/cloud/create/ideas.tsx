import type { Idea } from "../model.ts";
import { Skeleton } from "../ui/skeleton.tsx";

/**
 * Prompts to start from, for the chosen repo: two columns of quiet tiles. Choosing one fills the
 * composer; it never sends. While they are being made, `IdeasSkeleton` holds their place.
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

/** The height of a tile of two lines, which most ideas are: what a row of them takes. */
export const IDEA_ROW = 58;
/** Two rows and the gap between them: the room the create page keeps for ideas. */
export const IDEAS_ROOM = IDEA_ROW * 2 + 8;

/** Ideas on their way: four tiles in their places, each with two lines breathing. */
export function IdeasSkeleton() {
  return (
    <div role="status" aria-label="Finding ideas" className="grid grid-cols-2 gap-2">
      {[72, 88, 80, 64].map((width, i) => {
        // Each tile breathes a beat after the one before it.
        const delay = `${i * 120}ms`;
        return (
          <div
            key={width}
            className="flex flex-col justify-center gap-[9px] rounded-10 px-[13px] shadow-[inset_0_0_0_1px_var(--c-rule)]"
            style={{ height: IDEA_ROW }}
          >
            <Skeleton
              className="h-2 rounded-3"
              style={{ width: `${width}%`, animationDelay: delay }}
            />
            <Skeleton className="h-2 w-2/5 rounded-3" style={{ animationDelay: delay }} />
          </div>
        );
      })}
    </div>
  );
}
