/*
 * "One canvas, all kinds of work.": things people ask Ponzu for, drawn like the create page's
 * composer with a prompt typed in and its yuzu send button, so each reads as
 * a sentence someone could send.
 */

export const WORK = [
  "A pricing page, three takes",
  "Onboarding that gets people to their first win",
  "A dashboard for the numbers we check every morning",
  "A diagram of how our services talk",
  "Empty states for every screen",
  "The settings page, rebuilt",
  "A launch page and its share card",
  "A whole feature, sketch to merge",
] as const;

export function WorkChips() {
  return (
    <ul className="m-0 flex list-none flex-wrap justify-center gap-3 p-0">
      {WORK.map((prompt) => (
        <li
          key={prompt}
          className="flex items-center gap-3 rounded-full bg-well py-2 pr-2 pl-5 text-[15px]/[22px] text-text shadow-[inset_0_0_0_1px_var(--well-rule)]"
        >
          {prompt}
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-yuzu text-[#111110]"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="size-3.5"
              fill="none"
              stroke="currentColor"
            >
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
        </li>
      ))}
    </ul>
  );
}
