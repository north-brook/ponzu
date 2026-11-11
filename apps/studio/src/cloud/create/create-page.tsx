import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { Idea, PendingAttachment, Repo } from "../model.ts";
import { NewDesignComposer } from "./composer.tsx";
import type { ProjectChoice } from "./create.ts";
import { IDEAS_ROOM, Ideas, IdeasSkeleton } from "./ideas.tsx";
import type { ModelChoice } from "./model-picker.tsx";
import { RepoPicker } from "./repo-picker.tsx";

/** The least room above the column: where its top sits in a pane too short to centre it. */
const TOP = 130;

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
 * composer never moves when they arrive or don't, and the repo picker opens over the page
 * without moving it (its list is short, and has a search).
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
  // A page that expected ideas keeps their place for as long as it is open: ideas that never
  // come, or a switch to Scratch, don't move the composer down under the person.
  const [expectsIdeas, setExpectsIdeas] = useState(ideas !== null);
  if (ideas !== null && !expectsIdeas) setExpectsIdeas(true);
  const centre = useCentre(pane, column);

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
        className="mx-auto flex w-[660px] flex-col"
        style={{ paddingTop: TOP, transform: `translateY(${centre}px)` }}
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
 * when it doesn't fit (the pane scrolls then). Measured before the first paint and whenever the
 * pane or the column changes size, and placed at once: nothing here glides.
 */
function useCentre(
  pane: RefObject<HTMLDivElement | null>,
  column: RefObject<HTMLDivElement | null>,
): number {
  const [centre, setCentre] = useState(0);
  useLayoutEffect(() => {
    const p = pane.current;
    const c = column.current;
    if (!p || !c) return;
    const measure = () =>
      setCentre(Math.max(0, (p.clientHeight - 40 - (c.offsetHeight - TOP)) / 2 - TOP));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(p);
    observer.observe(c);
    return () => observer.disconnect();
  }, []);
  return centre;
}
