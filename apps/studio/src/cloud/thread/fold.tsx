import { memo, useRef, useState } from "react";
import { Slice } from "../ui/marks.tsx";
import { Prose } from "../ui/prose.tsx";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "../ui/trace.tsx";
import type { LineHandlers } from "./lines.tsx";
import type { FoldPart, TurnFold } from "./thread.ts";

/**
 * A finished turn's middle, folded to one quiet line: the still slice and what the turn came to
 * ("Worked for 2 min · 9 boards · 3 files"). It opens on the agent's messages before its answer,
 * each with what it did after it, in the same words as the working line in the past tense, so a
 * curious person can retrace the turn. Built on shadcn's Trace (its AI Elements' Chain of
 * Thought): a button with `aria-expanded`, opening at the pane's pace.
 */
export const TurnFoldLine = memo(function TurnFoldLine({
  fold,
  handlers,
  onToggle,
}: {
  fold: TurnFold;
  handlers: LineHandlers;
  /** Called with the trigger as it opens or closes, so the rail can hold it where it is. */
  onToggle?: (trigger: HTMLElement) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <TraceCollapsible
      open={open}
      onOpenChange={(next) => {
        if (trigger.current) onToggle?.(trigger.current);
        setOpen(next);
      }}
      className="px-[2px]"
      data-fold={fold.id}
    >
      <TraceCollapsibleTrigger
        ref={trigger}
        className="-mx-1 -my-0.5 px-1 py-0.5 hover:bg-hover hover:text-muted"
      >
        <TraceLine className="text-inherit">
          <TraceIcon>
            <Slice size={11} className="text-dry" />
          </TraceIcon>
          <TraceTitle>{fold.summary}</TraceTitle>
          <span className="sr-only">, what Claude did on the way</span>
        </TraceLine>
      </TraceCollapsibleTrigger>
      {/* The hairline hangs from the slice's middle; what it holds lines up with the summary. */}
      <TraceCollapsibleContent className="mt-2.5 ml-[5px] flex flex-col gap-2.5 pl-[11px]">
        {fold.parts.map((part) => (
          <Part key={partKey(part)} part={part} handlers={handlers} />
        ))}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
});

const partKey = (part: FoldPart) => (part.kind === "steps" ? part.id : part.item.id);

function Part({ part, handlers }: { part: FoldPart; handlers: LineHandlers }) {
  switch (part.kind) {
    case "message":
      return (
        <div className="text-13 text-muted leading-[1.5]">
          <Prose text={part.item.payload.text} onOpenLink={handlers.onOpenLink} />
        </div>
      );
    case "asked":
      return part.item.payload.type === "question" ? (
        <TraceLine>
          <TraceTitle>
            Asked: {part.item.payload.text}
            {part.item.payload.answer ? ` → ${part.item.payload.answer}` : ""}
          </TraceTitle>
        </TraceLine>
      ) : null;
    case "steps":
      return (
        <Trace className="gap-1" role="list" aria-label="Steps">
          {part.steps.map((step, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a step's text repeats; its place doesn't move
            <TraceLine key={i} role="listitem">
              <TraceTitle>{step.text}</TraceTitle>
              {step.count > 1 ? (
                <TraceDescription>
                  <span aria-hidden>×{step.count}</span>
                  <span className="sr-only">, {step.count} times</span>
                </TraceDescription>
              ) : null}
            </TraceLine>
          ))}
        </Trace>
      );
  }
}
