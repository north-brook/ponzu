import type { Idea } from "@ponzu/core";
import { ARRIVE_LAG_MS, ARRIVE_LINE, drawFrame, Icon, Rain, reducedMotion } from "@ponzu/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { arrivalOf } from "@/lib/suggestions";

/*
 * The Suggested tab's cards: designs the person's agent suggests for their recent projects, each
 * a dashed card holding what it would show, with its name and project where a design's are.
 * They arrive the way an artboard arrives on the canvas (packages/react/src/arrive.ts): a yuzu
 * line draws round the card, then what it holds fades in, while yuzu rain waits where the name
 * goes until the name and project fade in over it.
 */

/** From an idea arriving: the line starts (drawFrame), and the rest, after the line starts. */
const RAIN_IN = [-ARRIVE_LAG_MS, 110] as const;
const RAIN_OUT = [950, 1200] as const;
const CARD_IN = [550, 1000] as const;
const NAME_IN = [1000, 1350] as const;
/** Once the name is in, the arrival's done. */
const ARRIVAL_MS = ARRIVE_LAG_MS + NAME_IN[1];

/** How wide the rain runs where an arriving card's name goes. */
const NAME_RAIN_COLUMNS = 7;
/** How wide the rain runs while the first ideas are on their way: as an empty card preview has it. */
const THINKING_RAIN_COLUMNS = 8;

/** Before the first idea lands: only yuzu rain, centred. */
export function Thinking() {
  return (
    <div
      className="pz-appear grid h-[560px] place-items-center"
      role="status"
      aria-label="Looking for designs to suggest"
    >
      <Rain columns={THINKING_RAIN_COLUMNS} className="text-[30px]" />
    </div>
  );
}

export function SuggestionCard({ idea, onPick }: { idea: Idea; onPick: (idea: Idea) => void }) {
  const at = arrivalOf(idea);
  const [arriving, setArriving] = useState(
    () => at > 0 && performance.now() - at < ARRIVAL_MS && !reducedMotion(),
  );
  const frame = useRef<SVGRectElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const rain = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLDivElement>(null);

  // From when it arrived, so a card that remounts mid-arrival picks up where it was.
  useLayoutEffect(() => {
    if (!arriving) return;
    const now = performance.now();
    const line = at + ARRIVE_LAG_MS;
    if (frame.current) drawFrame(frame.current, at, now);
    const animations = [
      fadeIn(card.current, line, CARD_IN, now),
      fadeIn(name.current, line, NAME_IN, now),
      rain.current?.animate(
        [
          { opacity: 0, offset: 0 },
          { opacity: 1, offset: span(RAIN_IN) / span([RAIN_IN[0], RAIN_OUT[1]]) },
          { opacity: 1, offset: (RAIN_OUT[0] - RAIN_IN[0]) / span([RAIN_IN[0], RAIN_OUT[1]]) },
          { opacity: 0, offset: 1 },
        ],
        { duration: span([RAIN_IN[0], RAIN_OUT[1]]), fill: "both" },
      ),
    ];
    const r = animations[2];
    if (r) r.currentTime = now - (line + RAIN_IN[0]);
    const done = setTimeout(() => setArriving(false), at + ARRIVAL_MS - now);
    return () => {
      clearTimeout(done);
      for (const a of animations) a?.cancel();
    };
  }, [arriving, at]);

  const pick = () => onPick(idea);
  return (
    // A div, not a button, as a design's card is: a button can't hold block content.
    // biome-ignore lint/a11y/useSemanticElements: holds block content
    <div
      role="button"
      tabIndex={0}
      className="group flex min-w-0 cursor-default flex-col gap-2.5 text-left outline-none"
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      }}
    >
      <div className="relative aspect-[16/11]">
        <div
          ref={card}
          className="absolute inset-0 overflow-hidden text-pretty rounded-xl border border-foreground/18 border-dashed px-4 py-3.5 text-[13px] text-foreground/80 leading-5 transition-[border-color,box-shadow] group-hover:border-foreground/30 group-focus-visible:shadow-[0_0_0_2px_var(--ring)]"
        >
          {idea.card}
        </div>
        {arriving && (
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full overflow-visible"
          >
            <rect
              ref={frame}
              x={0.75}
              y={0.75}
              rx={12}
              pathLength={100}
              fill="none"
              stroke={ARRIVE_LINE}
              strokeWidth={1.5}
              strokeDasharray="100 100"
              strokeDashoffset={100}
              style={{ width: "calc(100% - 1.5px)", height: "calc(100% - 1.5px)" }}
            />
          </svg>
        )}
      </div>
      <div className="relative">
        {arriving && (
          <div ref={rain} className="absolute top-[9px] left-0.5 flex">
            <Rain columns={NAME_RAIN_COLUMNS} className="text-[17px]" />
          </div>
        )}
        <div ref={name} className="flex min-w-0 flex-col gap-0.5 px-0.5">
          <span className="min-w-0 truncate font-medium text-[13.5px]">{idea.name}</span>
          <ProjectLine idea={idea} />
        </div>
      </div>
    </div>
  );
}

function ProjectLine({ idea }: { idea: Idea }) {
  return (
    <span
      className="flex min-w-0 items-center gap-[5px] text-muted-foreground text-xs"
      title={idea.project}
    >
      <Icon name="repo" size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
      <span className="min-w-0 truncate">{idea.projectName}</span>
    </span>
  );
}

function span([from, to]: readonly [number, number]): number {
  return to - from;
}

/** Hidden until `from` after `start`, then fading in by `to`. */
function fadeIn(
  el: HTMLElement | null,
  start: number,
  [from, to]: readonly [number, number],
  now: number,
): Animation | undefined {
  if (!el) return undefined;
  const a = el.animate(
    [
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: from / to, easing: "ease-out" },
      { opacity: 1, offset: 1 },
    ],
    { duration: to, fill: "backwards" },
  );
  a.currentTime = now - start;
  return a;
}

/** A picked idea: its name, its project, the whole prompt, and Copy prompt. */
export function SuggestionDialog({
  idea,
  open,
  onClose,
}: {
  /** The idea, kept while the dialog closes. */
  idea: Idea | null;
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copy = () => {
    if (!idea) return;
    void navigator.clipboard.writeText(idea.prompt);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) return;
        onClose();
        setCopied(false);
      }}
    >
      <DialogContent aria-describedby={undefined}>
        {idea && <IdeaBody idea={idea} copied={copied} onCopy={copy} />}
      </DialogContent>
    </Dialog>
  );
}

/** What the dialog holds. */
export function IdeaBody({
  idea,
  copied,
  onCopy,
}: {
  idea: Idea;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <>
      <DialogHeader className="gap-2 pr-8">
        <DialogTitle>{idea.name}</DialogTitle>
        <ProjectLine idea={idea} />
      </DialogHeader>
      <div className="select-text rounded-[10px] bg-secondary px-3.5 py-3 text-[13px] leading-5 shadow-[inset_0_0_0_1px_var(--hairline)]">
        {idea.prompt}
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1" />
        <Button onClick={onCopy} className="text-[13px]">
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? "Copied" : "Copy prompt"}
        </Button>
      </div>
    </>
  );
}
