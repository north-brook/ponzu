import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Idea, PendingAttachment, Repo } from "../model.ts";
import { cn } from "../ui/cn.ts";
import { NewDesignComposer } from "./composer.tsx";
import type { ProjectChoice } from "./create.ts";
import { IDEAS_ROOM, Ideas, IdeasSkeleton } from "./ideas.tsx";
import type { ModelChoice } from "./model-picker.tsx";
import { RepoPicker } from "./repo-picker.tsx";

/** Where the column's top sits when it needs room below, for the open repo picker. */
const TOP = 130;
/** The open repo picker hangs this far under the chip (its `sideOffset`). */
const PICKER_GAP = 8;
/** And keeps this much of the pane clear under it, so it never touches the pane's edge. */
const PICKER_MARGIN = 16;

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
  /**
   * Prompts for the chosen repo; null shows none (the workspace has designs, or Scratch), and
   * "loading" their skeleton, in the room kept for them.
   */
  ideas: Idea[] | "loading" | null;
  /** An idea was picked into the composer: its place in the list, from 0. */
  onIdeaPicked?: (idea: Idea, position: number) => void;
  /** Images to send with the prompt. */
  attachments?: PendingAttachment[];
  onRemoveAttachment?: (id: string) => void;
}

/**
 * Starting a design, in the canvas pane: the question, the composer and the repo chip, and on a
 * workspace's first visit the ideas below them. The column is centred in the pane as one piece,
 * a little above true centre. Ideas have their room in it from the first frame (two rows of
 * tiles: a skeleton while they are made, then the ideas, or nothing if none come), so the
 * composer never moves when they arrive or don't. The column rises to a fixed top only when the
 * repo picker opens and its list would not fit below the chip where the column is.
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
  onIdeaPicked,
  attachments,
  onRemoveAttachment,
}: CreatePageProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // The open list, as it mounts (its portal mounts a commit after the picker opens).
  const [picker, setPicker] = useState<HTMLDivElement | null>(null);
  // A page that expected ideas keeps their place for as long as it is open: ideas that never
  // come, or a switch to Scratch, don't move the composer down under the person.
  const [expectsIdeas, setExpectsIdeas] = useState(ideas !== null);
  if (ideas !== null && !expectsIdeas) setExpectsIdeas(true);
  const lift = useCentreLift(pane, column, picker, pickerOpen);

  const pick = (idea: Idea) => {
    onPromptChange(idea.prompt);
    onIdeaPicked?.(idea, Array.isArray(ideas) ? ideas.indexOf(idea) : -1);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  return (
    <div ref={pane} data-create-composer className="absolute inset-0 overflow-y-auto">
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
            contentRef={setPicker}
          />
        </div>
        {/* 8 after the chip, as the column spaces its rows, and 22 more: the ideas' room, kept
            whether they are here yet or not. */}
        {expectsIdeas ? (
          // Prompts made from the repo: masked in a private recording (app/analytics/privacy.ts).
          // Its height is fixed, not a minimum: ideas that run to a third line hang below it
          // rather than growing the column, which would shift everything above them.
          <div data-replay="mask" className="mt-[30px]" style={{ height: IDEAS_ROOM }}>
            {ideas === "loading" ? (
              <IdeasSkeleton />
            ) : Array.isArray(ideas) && ideas.length > 0 ? (
              <Ideas ideas={ideas} onPick={pick} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * How far below TOP the column sits to be centred in the pane, 40px high of true centre; zero
 * when it doesn't fit. The open repo picker lifts it to TOP only when its list, as tall as it
 * really is, wouldn't fit below the chip where the column is, so the page doesn't jump for
 * nothing; once lifted it stays up while the picker is open (typing a search shortens the list,
 * and the column shouldn't chase it). `measured` is false until the column has been
 * drawn in its place once, so it doesn't glide into place on arrival.
 */
function useCentreLift(
  pane: RefObject<HTMLDivElement | null>,
  column: RefObject<HTMLDivElement | null>,
  picker: HTMLDivElement | null,
  pickerOpen: boolean,
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

  // What the open picker needs below the chip: its own height, measured as it opens (before
  // it paints) and as its list loads, and its gap and margin.
  const [needs, setNeeds] = useState<number | null>(null);
  const [raised, setRaised] = useState(false);
  useLayoutEffect(() => {
    if (!pickerOpen) {
      setNeeds(null);
      setRaised(false);
      return;
    }
    const el = picker;
    if (!el) return;
    const measure = () => setNeeds(el.offsetHeight + PICKER_GAP + PICKER_MARGIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pickerOpen, picker]);
  const short = pickerOpen && needs !== null && state.roomBelow < needs;
  if (short && !raised) setRaised(true);

  // The column may glide only once it has been drawn where it belongs: turning the transition
  // on in the same pass that first places it would slide it down from the top on arrival.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (!state.measured) return;
    const frame = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(frame);
  }, [state.measured]);

  const lifted = pickerOpen && (raised || short);
  return { offset: lifted ? 0 : state.centre, measured: placed };
}
