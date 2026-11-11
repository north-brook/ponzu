import { LayoutRightIcon } from "@hugeicons/core-free-icons";
import type { RailSignal } from "../status.ts";
import { IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { Slice } from "../ui/marks.tsx";
import { useShortcut } from "../ui/shortcut.ts";

/**
 * Opens and closes the thread rail (⌘J). While the rail is closed it carries the agent's state
 * in its place: a count of what waits on you, the turning slice, or a dot for something unseen.
 * Open, it is the plain icon: the rail itself says the rest.
 */
export function ThreadToggle({
  open,
  signal,
  onToggle,
}: {
  open: boolean;
  signal: RailSignal;
  onToggle: () => void;
}) {
  useShortcut("j", onToggle);
  const shown = open ? "idle" : signal;
  const label =
    typeof shown === "object"
      ? `${shown.needsYou} ${shown.needsYou === 1 ? "question" : "questions"} for you`
      : shown === "working"
        ? "Thread (working)"
        : shown === "unseen"
          ? "Thread (new activity)"
          : "Thread";
  return (
    <IconButton
      label={label}
      keys={["⌘", "J"]}
      aria-expanded={open}
      aria-controls="thread"
      onClick={onToggle}
      className="relative size-7"
    >
      {typeof shown === "object" ? (
        <span className="grid h-5 min-w-5 place-items-center rounded-pill bg-yuzu px-1.5 font-semibold text-12 text-yuzu-ink leading-none">
          {shown.needsYou}
        </span>
      ) : shown === "working" ? (
        <Slice size={16} turning className="text-yuzu" />
      ) : (
        <>
          <Icon icon={LayoutRightIcon} size={16} stroke={1.7} />
          {shown === "unseen" ? (
            <span className="absolute top-1 right-1 size-[7px] rounded-pill bg-yuzu shadow-[0_0_0_1.5px_var(--c-chrome)]" />
          ) : null}
        </>
      )}
    </IconButton>
  );
}
