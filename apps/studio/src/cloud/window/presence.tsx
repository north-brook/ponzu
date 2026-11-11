import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { type Contributor, firstName } from "../model.ts";
import { ago, useNow } from "../time.ts";
import { Avatar } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { PopoverTrigger } from "../ui/popover.tsx";
import { Tip } from "../ui/tooltip.tsx";

/** How many avatars the chrome shows; the rest are in Share's list. */
export const PRESENCE_LIMIT = 5;

/**
 * Everyone who has worked on the design, you first: full strength while they're here, faded to
 * 40% once they've gone. Hovering one says who, and for someone away, when they were last here.
 * The "+" after them opens Share (it must sit in the Share popover's root); open, it takes the
 * open row's ground instead of its ring.
 */
export function Presence({ contributors, meId }: { contributors: Contributor[]; meId: string }) {
  const now = useNow();
  const ordered = contributors.toSorted(
    (a, b) => Number(b.person.id === meId) - Number(a.person.id === meId),
  );
  return (
    <div className="flex shrink-0 items-center">
      <div className="flex">
        {ordered.slice(0, PRESENCE_LIMIT).map((c, i) => {
          const you = c.person.id === meId;
          const name = `${firstName(c.person)}${you ? " (you)" : ""}`;
          const away = !you && !c.here;
          const label =
            away && c.lastHereAt ? `${name} · last here ${ago(c.lastHereAt, now, "long")}` : name;
          return (
            <Tip key={c.person.id} label={label}>
              <span
                role="img"
                aria-label={label}
                className={cn("flex", i > 0 && "-ml-1.5", away && "opacity-40")}
              >
                <Avatar person={c.person} size={22} ring="chrome" />
              </span>
            </Tip>
          );
        })}
      </div>
      <Tip label="Share">
        <PopoverTrigger
          aria-label="Share"
          className="app-no-drag ml-[3px] grid size-[22px] shrink-0 cursor-default place-items-center rounded-pill text-muted shadow-[inset_0_0_0_1px_var(--c-outline)] outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover aria-expanded:bg-canvas aria-expanded:shadow-none"
        >
          <Icon icon={PlusSignIcon} size={11} stroke={2.4} />
        </PopoverTrigger>
      </Tip>
    </div>
  );
}
