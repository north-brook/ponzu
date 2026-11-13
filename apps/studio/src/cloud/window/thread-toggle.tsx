import { LayoutRightIcon } from "@hugeicons/core-free-icons";
import { drivingLine, drivingTitle } from "@ponzu/client/model/driver";
import type { RailSignal } from "../status.ts";
import { useNow } from "../time.ts";
import { Button, IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { AgentMark, Slice } from "../ui/marks.tsx";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { paneHeld, useShortcut } from "../ui/shortcut.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

/**
 * The person's own agent driving the canvas in place of Ponzu's (docs/cloud.md, "Your own
 * agent"), as the toggle shows it: its mark, and its words on hover and in the popover.
 */
export interface ToggleDriver {
  /** Which mark: `claude`, `openai` (Codex), `cursor`, `t3`, or anything else's dot. */
  client: string;
  name: string;
  /** The app it runs in, when it said ("T3 Code"). */
  host: string | null;
  /** When it took the canvas, ISO 8601. */
  since: string;
  /** Asks to take the canvas back (it confirms first); null for someone who may only look. */
  onTakeBack: (() => void) | null;
}

/**
 * Opens and closes the thread rail (⌥⌘B). While the rail is closed it carries the agent's state
 * in its place: a count of what waits on you, the turning slice, or a dot for something unseen.
 * Open, it is the plain icon: the rail itself says the rest.
 *
 * While the person's own agent drives the canvas (`driver`), the rail is closed and can't open:
 * the toggle is that agent's mark, its tip says who drives and since when, and pressing it opens
 * a popover with the same words and Take back.
 */
export function ThreadToggle({
  open,
  signal,
  onToggle,
  driver = null,
}: {
  open: boolean;
  signal: RailSignal;
  onToggle: () => void;
  driver?: ToggleDriver | null;
}) {
  // Not under a menu or a modal (paneHeld), as ⌘B. While driven there is no rail to open.
  // ⌥⌘B, the sidebar's ⌘B with ⌥: the two panes are one pair of keys.
  useShortcut("b", () => paneHeld("thread") || driver !== null || onToggle(), true, { alt: true });
  if (driver) return <DriverToggle driver={driver} />;
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
      keys={["⌥", "⌘", "B"]}
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
          <Icon icon={LayoutRightIcon} step="control" />
          {shown === "unseen" ? (
            <span className="absolute top-1 right-1 size-[7px] rounded-pill bg-yuzu shadow-[0_0_0_1.5px_var(--c-chrome)]" />
          ) : null}
        </>
      )}
    </IconButton>
  );
}

/** The toggle while an agent drives: its mark, a two-line tip, and a popover with Take back. */
function DriverToggle({ driver }: { driver: ToggleDriver }) {
  const now = useNow();
  const title = drivingTitle(driver);
  const line = drivingLine(driver, now);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="icon"
              aria-label={title}
              data-driver={driver.client}
              className="size-7 text-ink"
            >
              <AgentMark client={driver.client} size={16} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="end"
          className="h-auto max-w-[320px] flex-col items-start gap-0.5 whitespace-normal py-1.5"
        >
          <span>{title}</span>
          <span className="opacity-70">{line}</span>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        width={300}
        side="bottom"
        align="end"
        sideOffset={10}
        aria-label={title}
        className="p-4"
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-px grid size-5 shrink-0 place-items-center text-ink">
            <AgentMark client={driver.client} size={18} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="m-0 font-semibold text-14 leading-[1.35]">{title}</h2>
            <p className="m-0 text-13 text-muted leading-[1.45]">{line}</p>
          </div>
        </div>
        {driver.onTakeBack ? (
          <div className="mt-3.5 flex justify-end">
            {/* The popover gives way to the dialog that asks first. */}
            <PopoverClose asChild>
              <Button variant="action" className="px-3" onClick={driver.onTakeBack}>
                Take back
              </Button>
            </PopoverClose>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
