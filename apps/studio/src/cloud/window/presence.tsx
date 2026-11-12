import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { type KeyboardEvent, useState } from "react";
import { type Contributor, firstName } from "../model.ts";
import { ago, useNow } from "../time.ts";
import { Avatar } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { PopoverTrigger } from "../ui/popover.tsx";
import { Tip } from "../ui/tooltip.tsx";
import { Arrival } from "./arrival.tsx";

/** How many avatars the chrome shows; the rest are in Share's list. */
export const PRESENCE_LIMIT = 5;

/**
 * Everyone who has worked on the canvas, you first: full strength while they're here, faded to
 * 40% once they've gone. Hovering one, or reaching it with the keyboard (one Tab stop, then the
 * arrows), says who, and for someone away, when they were last here. The "+" after them opens
 * Share (it must sit in the Share popover's root). It is one of the stack: it overlaps the last
 * avatar as each avatar does the one before it, on the shell's own ground with the same hairline
 * of it cut around, so the face under it doesn't show through. Open, it takes the selected
 * ground instead of its ring.
 */
export function Presence({ contributors, meId }: { contributors: Contributor[]; meId: string }) {
  const now = useNow();
  const [focused, setFocused] = useState(0);
  const shown = contributors
    .toSorted((a, b) => Number(b.person.id === meId) - Number(a.person.id === meId))
    .slice(0, PRESENCE_LIMIT);
  const stop = Math.min(focused, shown.length - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const next = stop + step;
    if (!step || next < 0 || next >= shown.length) return;
    e.preventDefault();
    setFocused(next);
    // Not someone on their way out (inert while they leave).
    [...e.currentTarget.querySelectorAll<HTMLElement>('[role="img"]')]
      .filter((el) => !el.closest("[inert]"))
      [next]?.focus();
  };

  return (
    <div className="flex shrink-0 items-center">
      {/* biome-ignore lint/a11y/useSemanticElements: a group of avatars, not a form's fieldset */}
      <div role="group" aria-label="People in this canvas" onKeyDown={onKeyDown} className="flex">
        {shown.map((c, i) => {
          const you = c.person.id === meId;
          const name = `${firstName(c.person)}${you ? " (you)" : ""}`;
          const away = !you && !c.here;
          const label =
            away && c.lastHereAt ? `${name} · last here ${ago(c.lastHereAt, now, "long")}` : name;
          return (
            // Someone who joins after the first paint (presence and the thread come a moment
            // after the canvas) arrives: their room opens, those before them glide aside, and
            // they fade in. Drawn whole as their room opens, since each overlaps the one before.
            <Arrival key={c.person.id} show clip={false} name="person">
              <Tip label={label}>
                <span
                  role="img"
                  aria-label={label}
                  tabIndex={i === stop ? 0 : -1}
                  onFocus={() => setFocused(i)}
                  className={cn(
                    "app-no-drag flex rounded-pill outline-none focus-ring",
                    i > 0 && "-ml-1.5",
                    away && "opacity-40",
                  )}
                >
                  <Avatar person={c.person} size={22} ring="chrome" />
                </span>
              </Tip>
            </Arrival>
          );
        })}
      </div>
      <Tip label="Share">
        <PopoverTrigger
          aria-label="Share"
          className="app-no-drag -ml-1.5 relative grid size-[22px] shrink-0 cursor-default place-items-center rounded-pill bg-chrome text-muted shadow-[inset_0_0_0_1px_var(--c-outline),0_0_0_1.5px_var(--c-chrome)] outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-[image:linear-gradient(var(--c-hover),var(--c-hover))] aria-expanded:bg-selected aria-expanded:bg-none aria-expanded:shadow-[0_0_0_1.5px_var(--c-chrome)]"
        >
          <Icon icon={PlusSignIcon} step="meta" />
        </PopoverTrigger>
      </Tip>
    </div>
  );
}
