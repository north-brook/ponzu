import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { Idea, PendingAttachment, Repo } from "../model.ts";
import { cn } from "../ui/cn.ts";
import { NewDesignComposer } from "./composer.tsx";
import type { ProjectChoice } from "./create.ts";
import { Ideas } from "./ideas.tsx";
import type { ModelChoice } from "./model-picker.tsx";
import { RepoPicker } from "./repo-picker.tsx";

/** Where the column's top sits when it needs room below: for ideas, or the open repo picker. */
const TOP = 130;
/** What the open repo picker takes below the chip: its list at its tallest, and a margin. */
const PICKER_ROOM = 340;

export interface CreatePageProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  onAttach: () => void;
  sending?: boolean;
  /** Null until the person's defaults are known: a design sent then starts on them. */
  model: ModelChoice | null;
  project: ProjectChoice;
  /** The repos the App can see, pushed-to lately first; null while they load. */
  repos: Repo[] | null;
  onProjectChange: (project: ProjectChoice) => void;
  onAllowMore: () => void;
  /** Prompts for the chosen repo; null shows none (the workspace has designs, or Scratch). */
  ideas: Idea[] | "loading" | null;
  /** Images to send with the prompt. */
  attachments?: PendingAttachment[];
  onRemoveAttachment?: (id: string) => void;
}

/**
 * Starting a design, in the canvas pane: the question, the composer and the repo chip. On a
 * workspace's first visit ideas follow below. The column sits a little above centre, and rises
 * to a fixed top when it needs the room below (ideas, or the repo picker open).
 */
export function CreatePage({
  prompt,
  onPromptChange,
  onSend,
  onAttach,
  sending,
  model,
  project,
  repos,
  onProjectChange,
  onAllowMore,
  ideas,
  attachments,
  onRemoveAttachment,
}: CreatePageProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const lift = useCentreLift(pane, column, ideas !== null, pickerOpen);

  const pick = (idea: Idea) => {
    onPromptChange(idea.prompt);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  return (
    <div ref={pane} className="absolute inset-0 overflow-y-auto">
      <div
        ref={column}
        className={cn(
          "mx-auto flex w-[660px] flex-col",
          lift.measured && "transition-transform duration-(--dur-pane) ease-out",
        )}
        style={{ paddingTop: TOP, transform: `translateY(${lift.offset}px)` }}
      >
        <h1 className="m-0 mb-9 text-center font-display font-semibold text-34 text-ink tracking-[-0.02em]">
          What do you want to design?
        </h1>
        <NewDesignComposer
          prompt={prompt}
          onPromptChange={onPromptChange}
          onSend={onSend}
          onAttach={onAttach}
          sending={sending}
          model={model}
          fieldRef={field}
          {...(attachments ? { attachments } : {})}
          {...(onRemoveAttachment ? { onRemoveAttachment } : {})}
        />
        <div className="mt-2 flex items-center px-1.5">
          <RepoPicker
            value={project}
            repos={repos}
            onChange={onProjectChange}
            onAllowMore={onAllowMore}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
        </div>
        {/* 8 after the chip, as the column spaces its rows, and 22 more. */}
        {ideas ? (
          <div className="mt-[30px]">
            <Ideas ideas={ideas} onPick={pick} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * How far below TOP the column sits to be centred in the pane, 40px high of true centre; zero
 * when it should sit at TOP (ideas follow) or doesn't fit. The open repo picker lifts it only
 * when the picker wouldn't fit below it where it is, so the page doesn't jump for nothing.
 * `measured` is false until the first measure, so the column doesn't glide into place on arrival.
 */
function useCentreLift(
  pane: RefObject<HTMLDivElement | null>,
  column: RefObject<HTMLDivElement | null>,
  top: boolean,
  picker: boolean,
) {
  const [state, setState] = useState({ centre: 0, roomBelow: 0, measured: false });
  useLayoutEffect(() => {
    const p = pane.current;
    const c = column.current;
    if (!p || !c) return;
    const measure = () => {
      const content = c.offsetHeight - TOP;
      const centre = Math.max(0, (p.clientHeight - 40 - content) / 2 - TOP);
      const roomBelow = p.clientHeight - (TOP + centre + content);
      setState((s) =>
        s.centre === centre && s.roomBelow === roomBelow && s.measured
          ? s
          : { centre, roomBelow, measured: true },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(p);
    observer.observe(c);
    return () => observer.disconnect();
  }, []);
  const lifted = top || (picker && state.roomBelow < PICKER_ROOM);
  return { offset: lifted ? 0 : state.centre, measured: state.measured };
}
