import type { CatalogMachine, Idea, IdeaStep, LookingAt, SuggestionAgent } from "@ponzu/core";
import { ARRIVE_LAG_MS, ARRIVE_LINE, drawFrame, Icon, Rain, reducedMotion } from "@ponzu/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { arrivalOf } from "@/lib/suggestions";
import { cn } from "@/lib/utils";

/*
 * The Suggested tab's cards: designs the person's agent suggests for their recent projects, each
 * a dashed card holding the prompt that asks for it, with its name and project where a design's are.
 * While a run looks around a project, the project has a card of its own, rain where a name goes.
 * Its ideas arrive the way an artboard arrives on the canvas (packages/react/src/arrive.ts): a
 * yuzu line draws round the card while the name and project fade in. Until its prompt is written,
 * the card shows what the agent reads; then the prompt fades in.
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

/** Before the projects are known: only yuzu rain, centred. */
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

/** A project a run is still looking around, before it names its designs. */
export function LookingCard({ at, machine }: { at: LookingAt; machine?: CatalogMachine }) {
  return (
    <div
      className="pz-appear flex min-w-0 flex-col gap-2.5"
      role="status"
      aria-label={`Looking around ${at.folder}`}
    >
      <div className="aspect-[16/11] rounded-xl border border-foreground/18 border-dashed px-4 py-3.5">
        <span className="pz-shimmer block truncate text-[12px] text-muted-foreground leading-[18px]">
          Looking around {at.folder}…
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="flex h-5 items-center">
          <Rain columns={NAME_RAIN_COLUMNS} className="text-[17px]" />
        </span>
        <ProjectLine project={at.project} name={at.projectName} machine={machine} />
      </div>
    </div>
  );
}

export function SuggestionCard({
  idea,
  machine,
  onPick,
}: {
  idea: Idea;
  /** The other Mac it's for, whose folders its prompt names. */
  machine?: CatalogMachine;
  onPick: (idea: Idea) => void;
}) {
  const at = arrivalOf(idea);
  // One that mounts while its prompt is written fades the prompt in when it comes.
  const [writing] = useState(() => !idea.prompt);
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
          className="absolute inset-0 overflow-hidden rounded-xl border border-foreground/18 border-dashed px-4 py-3.5 transition-[border-color,box-shadow] group-hover:border-foreground/30 group-focus-visible:shadow-[0_0_0_2px_var(--ring)]"
        >
          {idea.prompt ? (
            // The whole prompt, faded out where the card cuts it off.
            <p
              className={cn(
                "h-full overflow-hidden text-pretty wrap-break-word text-[12px] text-foreground/80 leading-[18px] [mask-image:linear-gradient(to_bottom,#000_calc(100%-40px),transparent)]",
                writing && "pz-appear",
              )}
            >
              {idea.prompt}
            </p>
          ) : (
            <Reading steps={idea.steps ?? []} />
          )}
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
          <ProjectLine project={idea.project} name={idea.projectName} machine={machine} />
        </div>
      </div>
    </div>
  );
}

/** The project, and the other Mac it's on, as a design's card names its Mac. */
function ProjectLine({
  project,
  name,
  machine,
}: {
  project: string;
  name: string;
  machine?: CatalogMachine;
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-[5px] text-muted-foreground text-xs"
      title={machine ? `${project} on ${machine.name}` : project}
    >
      <Icon name="repo" size={13} strokeWidth={1.7} className="shrink-0 text-faint" />
      <span className="min-w-0 truncate">{name}</span>
      {machine && (
        <>
          <span className="text-faint">·</span>
          <Icon
            name={machine.kind === "laptop" ? "laptop" : "desktop"}
            size={13}
            strokeWidth={1.7}
            className="shrink-0 text-faint"
          />
          <span className="min-w-0 truncate">{machine.name}</span>
        </>
      )}
    </span>
  );
}

const VERBS: Record<IdeaStep["verb"], string> = {
  read: "Reading",
  find: "Finding",
  search: "Searching for",
};

/** While a prompt is written: what the agent reads, as it reads it, the latest brightest. */
function Reading({ steps, label = "Reading the code…" }: { steps: IdeaStep[]; label?: string }) {
  // Keyed by what each is, so only a new one fades in as older ones scroll off.
  const seen = new Map<string, number>();
  return (
    <div className="flex h-full min-w-0 flex-col gap-1.5" role="status">
      <span className="pz-shimmer mb-1 text-[12px] text-muted-foreground leading-[18px]">
        {label}
      </span>
      {steps.map((step, i) => {
        const id = `${step.verb}:${step.what}`;
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        return (
          <span
            key={`${id}:${n}`}
            className="pz-appear flex min-w-0 items-baseline gap-1.5 text-[11.5px] leading-4"
          >
            <span className="shrink-0 text-faint">{VERBS[step.verb]}</span>
            <span
              className={cn(
                "min-w-0 truncate font-mono text-[11px]",
                i === steps.length - 1 ? "text-foreground/80" : "text-faint",
              )}
            >
              {step.verb === "search" ? `“${step.what}”` : step.what}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const AGENTS: Record<SuggestionAgent, string> = { claude: "Claude Code", codex: "Codex" };

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

/**
 * A picked idea: its name, its project, the whole prompt, and Copy prompt. Picked before its
 * prompt is written, it shows what the agent reads until it is.
 */
export function SuggestionDialog({
  idea,
  machine,
  agent,
  open,
  onClose,
}: {
  /** The idea as it is now, kept while the dialog closes. */
  idea: Idea | null;
  machine?: CatalogMachine;
  agent: SuggestionAgent | null;
  open: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copy = () => {
    if (!idea?.prompt) return;
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
        {idea && (
          <IdeaBody idea={idea} machine={machine} agent={agent} copied={copied} onCopy={copy} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What the dialog holds. */
export function IdeaBody({
  idea,
  machine,
  agent = null,
  copied,
  onCopy,
}: {
  idea: Idea;
  machine?: CatalogMachine;
  agent?: SuggestionAgent | null;
  copied: boolean;
  onCopy: () => void;
}) {
  const writing = !idea.prompt;
  return (
    <>
      <DialogHeader className="gap-2 pr-8">
        <DialogTitle>{idea.name}</DialogTitle>
        <ProjectLine project={idea.project} name={idea.projectName} machine={machine} />
      </DialogHeader>
      <div
        className={cn(
          "select-text wrap-break-word rounded-[10px] bg-secondary px-3.5 py-3 text-[13px] leading-5 shadow-[inset_0_0_0_1px_var(--hairline)]",
          writing && "min-h-30",
        )}
      >
        {writing ? (
          <Reading
            steps={idea.steps ?? []}
            label={`${agent ? AGENTS[agent] : "Your agent"} is reading ${idea.projectName} to write this prompt…`}
          />
        ) : (
          idea.prompt
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-faint text-xs">
          {writing && "Copy prompt works once it’s written."}
        </span>
        <Button onClick={onCopy} disabled={writing} className="text-[13px]">
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? "Copied" : "Copy prompt"}
        </Button>
      </div>
    </>
  );
}
