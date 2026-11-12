import { useEffect, useState } from "react";
import type { Idea } from "../model.ts";

/** How long a suggestion stays in the composer before the next takes its place. */
export const SUGGESTION_DWELL_MS = 4500;

/** The idea the composer is suggesting, and the one it took over from, on its way out. */
export interface Suggestion {
  idea: Idea;
  /** Its place in the list, from 0. */
  index: number;
  leaving: Idea | null;
}

/**
 * The ideas for the chosen repo, one at a time: each takes its turn as the composer's
 * placeholder, then gives way to the next, round and round, for as long as the composer is
 * empty and showing (`showing`). A different list starts again from its first. One idea stays
 * put; none is no suggestion. Nothing moves while the window is hidden.
 */
export function useSuggestion(
  ideas: Idea[] | null,
  showing: boolean,
  dwell = SUGGESTION_DWELL_MS,
): Suggestion | null {
  const list = ideas ?? [];
  const key = list.map((idea) => idea.id).join("\n");
  const [at, setAt] = useState<{ key: string; index: number; leaving: Idea | null }>({
    key,
    index: 0,
    leaving: null,
  });
  if (at.key !== key) setAt({ key, index: 0, leaving: null });

  const count = list.length;
  useEffect(() => {
    if (!showing || count < 2) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      setAt((was) => ({
        key: was.key,
        index: (was.index + 1) % count,
        leaving: ideas?.[was.index] ?? null,
      }));
    }, dwell);
    return () => clearInterval(timer);
    // `key` names the list: a new array of the same ideas keeps the turn it is on.
  }, [showing, count, key, dwell]);

  const index = at.key === key ? at.index : 0;
  const idea = list[index];
  if (!idea) return null;
  return { idea, index, leaving: at.key === key ? at.leaving : null };
}

/**
 * The suggestion as the composer's placeholder, over the empty field: the idea in the
 * placeholder's own type and colour, and the key that takes it. Each one rises into place as the
 * one before it lifts away. It is a picture of a placeholder, not a control: the pointer passes
 * through to the field, and the field describes it to assistive tech (composer.tsx).
 */
export function SuggestionLine({ suggestion }: { suggestion: Suggestion }) {
  const { idea, leaving } = suggestion;
  return (
    <div
      aria-hidden
      // Prompts made from the repo: masked in a private recording (app/analytics/privacy.ts).
      data-replay="mask"
      data-suggestion={idea.id}
      className="pointer-events-none absolute inset-x-0 top-0 pr-2 text-16 text-faint leading-[1.5]"
    >
      {leaving && leaving.id !== idea.id ? (
        <span
          key={`out:${leaving.id}`}
          className="suggestion-out absolute inset-x-0 top-0 line-clamp-2 pr-2"
        >
          {leaving.prompt}
        </span>
      ) : null}
      <span key={idea.id} className="suggestion-in line-clamp-2">
        {idea.prompt}
        <kbd className="ml-2 inline-block rounded-4 px-[5px] align-[1.5px] font-sans text-11 text-faint leading-[17px] shadow-[inset_0_0_0_1px_var(--c-rule)]">
          tab
        </kbd>
      </span>
    </div>
  );
}
