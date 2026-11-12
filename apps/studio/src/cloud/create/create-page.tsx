import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { Idea, PendingAttachment, Repo } from "../model.ts";
import { Lockup } from "../ui/marks.tsx";
import { NewDesignComposer } from "./composer.tsx";
import type { ProjectChoice, RepoShelf } from "./create.ts";
import { type Suggestion, useSuggestion } from "./ideas.tsx";
import type { ModelChoice } from "./model-picker.tsx";
import { RepoPicker } from "./repo-picker.tsx";

/** The logo's word size: under the 46 it had alone, so the selector beside it balances. */
const LOGO = 40;

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
  /** Null until the window's repos are known: the selector holds its place meanwhile. */
  project: ProjectChoice | null;
  /** The window's workspace's repos the person can push to, pushed-to lately first; null while they load. */
  repos: Repo[] | null;
  /** The other workspaces' repos that have arrived, in the workspace switcher's order. */
  elsewhere?: readonly RepoShelf[];
  /** `workspaceId` is another workspace's for one of its repos, else null. */
  onProjectChange: (project: ProjectChoice, workspaceId: string | null) => void;
  onAllowMore: () => void;
  /**
   * Prompts for the chosen repo, which take turns as the composer's placeholder; null (the
   * workspace has designs, or Scratch) and "loading" (they are being made) show the plain
   * placeholder.
   */
  ideas: Idea[] | "loading" | null;
  /** An idea was taken into the composer with Tab: its place in the list, from 0. */
  onIdeaPicked?: (idea: Idea, position: number) => void;
  /** How long each idea shows before the next: the gallery's tests shorten it. */
  suggestionDwellMs?: number;
  /** Images to send with the prompt. */
  attachments?: PendingAttachment[];
  onRemoveAttachment?: (id: string) => void;
}

/**
 * Starting a design, in the canvas pane, on the canvas's own dotted ground, since this is where a
 * canvas starts: a header (Ponzu's logo, a hairline, and the project selector) over the composer,
 * and nothing under it. The column is centred in the pane as one piece, a little above true
 * centre. On a workspace's first visits the ideas for the chosen repo take turns as the
 * composer's placeholder (composer.tsx), so nothing on the page moves when they arrive or don't,
 * and the repo picker opens over the page without moving it (its list is short, and has a
 * search).
 *
 * The header's hairline stands on the column's centre line, the logo ending a fixed gap before
 * it and the selector starting one after, so neither moves when the other changes: a repo
 * chosen, the repos arriving, a long name. Each is centred on the row's line, which is the
 * logo's mark's centre (the lockup is drawn round it), so the hairline and the selector's words
 * sit on the mark. The selector has the column's right half at most and cuts a long name short
 * there.
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
  elsewhere,
  onProjectChange,
  onAllowMore,
  ideas,
  onIdeaPicked,
  attachments,
  onRemoveAttachment,
  suggestionDwellMs,
}: CreatePageProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const centre = useCentre(pane, column);
  // The ideas take their turns only while there is an empty field to show them in.
  const suggestion = useSuggestion(
    Array.isArray(ideas) ? ideas : null,
    prompt === "",
    suggestionDwellMs,
  );

  const accept = ({ idea, index }: Suggestion) => {
    onPromptChange(idea.prompt);
    onIdeaPicked?.(idea, index);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  return (
    <div ref={pane} data-create-composer className="canvas-dots absolute inset-0 overflow-y-auto">
      <div
        ref={column}
        className="mx-auto flex w-[660px] flex-col"
        style={{ paddingTop: TOP, transform: `translateY(${centre}px)` }}
      >
        <div
          data-create-header
          className="mb-9 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
        >
          {/* The logo stands where a question did; the question is still the page's heading. */}
          <h1 className="m-0 mr-4 flex justify-end text-ink">
            <Lockup size={LOGO} />
            <span className="sr-only">What do you want to design?</span>
          </h1>
          <div aria-hidden data-create-divider className="h-7 w-px bg-rule" />
          <div className="ml-2 flex min-w-0">
            <RepoPicker
              value={project}
              repos={repos}
              {...(elsewhere ? { elsewhere } : {})}
              onChange={onProjectChange}
              onAllowMore={onAllowMore}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
            />
          </div>
        </div>
        <NewDesignComposer
          prompt={prompt}
          onPromptChange={onPromptChange}
          onSend={onSend}
          onAttach={onAttach}
          sending={sending}
          model={model}
          fieldRef={field}
          suggestion={suggestion}
          onAcceptSuggestion={accept}
          {...(attachments ? { attachments } : {})}
          {...(onRemoveAttachment ? { onRemoveAttachment } : {})}
        />
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
