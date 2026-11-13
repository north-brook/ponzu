import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import type { Idea, PendingAttachment, Repo } from "../model.ts";
import { cn } from "../ui/cn.ts";
import { Slice } from "../ui/marks.tsx";
import { NewCanvasComposer } from "./composer.tsx";
import {
  DOCK_INSET,
  heroPlace,
  MARK,
  MARK_GAP,
  type ProjectChoice,
  projectLabel,
  type RepoShelf,
  STATEMENT_ROOM,
} from "./create.ts";
import { type Suggestion, useSuggestion } from "./ideas.tsx";
import type { ModelChoice } from "./model-picker.tsx";
import { RepoPicker } from "./repo-picker.tsx";

export interface CreatePageProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  onAttach: () => void;
  sending?: boolean;
  /**
   * A send has gone: the hero leaves and the composer is away (travelling to the thread, then
   * there), leaving the dotted ground for the new canvas's boards. Back to false, a send that
   * failed finds everything where it was, the caret in the field.
   */
  launched?: boolean;
  /** Null until the person's defaults are known: a canvas sent then starts on them. */
  model: ModelChoice | null;
  /** Null until the window's repos are known: the selector holds its place meanwhile. */
  project: ProjectChoice | null;
  /** The window's workspace's name: its group's heading in the picker, and whose Scratch it is. */
  workspaceName?: string;
  /** The window's workspace's repos the person can push to, pushed-to lately first; null while they load. */
  repos: Repo[] | null;
  /** Each other usable workspace, in the workspace switcher's order, with its repos once they arrive. */
  elsewhere?: readonly RepoShelf[];
  /** `workspaceId` is another workspace's for its Scratch or one of its repos, else null. */
  onProjectChange: (project: ProjectChoice, workspaceId: string | null) => void;
  onAllowMore: () => void;
  /**
   * Prompts for the chosen repo, which take turns as the composer's placeholder; null (the
   * workspace has canvases, or Scratch) and "loading" (they are being made) show the plain
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
 * Starting a canvas, in the main pane, on the same dotted ground its boards will sit on. The hero
 * (Ponzu's mark over one statement that ends in the project selector) is centred in the pane, a
 * little high (`HERO_RISE`); the composer is docked at the
 * pane's foot, where the thread's composer sits in its rail, and grows upward with what is typed
 * or attached. On a workspace's first visits the ideas for the chosen repo take turns as the
 * composer's placeholder (composer.tsx), so nothing on the page moves when they arrive or don't,
 * and the repo picker opens over the page under the selector without moving it.
 *
 * The hero holds still as the composer grows, and gives way only once the composer would come
 * near it (`heroPlace`): the statement rises ahead of it, and the mark fades once there is no
 * room for it above. Placed before the first paint and whenever the pane, the composer or the
 * statement change size: nothing here glides but the mark's fade.
 */
export function CreatePage({
  prompt,
  onPromptChange,
  onSend,
  onAttach,
  sending,
  launched = false,
  model,
  project,
  workspaceName,
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
  const dock = useRef<HTMLDivElement>(null);
  const statement = useRef<HTMLDivElement>(null);
  const place = useHeroPlace(pane, dock, statement);
  // Sent, the page keeps the width it had while the thread's pane opens over its side, so the
  // hero fades where it stood rather than sliding to the narrower pane's centre.
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el || !launched) return;
    // Measured while both its edges still hold it: freed of its right one, it would shrink to fit.
    const width = el.offsetWidth;
    el.style.width = `${width}px`;
    el.style.right = "auto";
    return () => {
      el.style.right = "";
      el.style.width = "";
    };
  }, [launched]);
  // A send that came back (launched, then not) gives the caret back to the field. Here, as the
  // page that shows the field again is committed, not a frame after the failure: a busy machine
  // can draw that frame before React has committed, while the field is still hidden, and the
  // caret would be lost.
  const wasLaunched = useRef(launched);
  useLayoutEffect(() => {
    const cameBack = wasLaunched.current && !launched;
    wasLaunched.current = launched;
    if (cameBack) field.current?.focus({ preventScroll: true });
  }, [launched]);
  // The ideas take their turns only while there is an empty field to show them in.
  const suggestion = useSuggestion(
    Array.isArray(ideas) ? ideas : null,
    prompt === "" && !launched,
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
    <div
      ref={pane}
      data-create-composer
      data-launched={launched || undefined}
      className="canvas-dots absolute inset-0 flex flex-col overflow-y-auto"
    >
      <div
        data-create-hero
        // Gone at once on a send (it fades as the composer leaves); back the same way.
        className={cn(
          "flex shrink-0 flex-col items-center transition-opacity duration-(--dur-pane) ease-(--ease-out)",
          launched && "pointer-events-none opacity-0",
        )}
        style={{ paddingTop: place?.top ?? 0, visibility: place ? undefined : "hidden" }}
        inert={launched}
      >
        <div ref={statement} className="relative flex max-w-[660px] flex-col items-center">
          {/* Over the statement, not in its flow: the statement's place is the hero's. */}
          <span
            data-create-mark
            aria-hidden
            className={cn(
              "absolute left-1/2 flex -translate-x-1/2 transition-opacity duration-(--dur-pop)",
              place?.mark === false && "opacity-0",
            )}
            style={{ bottom: `calc(100% + ${MARK_GAP}px)` }}
          >
            <Slice size={MARK} className="text-ink" />
          </span>
          {/* One statement: what this page is for, then where. A repo takes the second line
              (as does the selector's skeleton while the project is being found); Scratch ends
              the first ("from scratch"). The room is two lines either way, and the first line
              is at its top in both, so nothing above it moves when the project changes. */}
          <div
            data-create-statement
            className={cn(
              "flex max-w-full font-display font-semibold text-28 text-ink",
              project?.kind === "scratch"
                ? "items-baseline justify-center"
                : "flex-col items-center justify-start",
            )}
            style={{ minHeight: STATEMENT_ROOM }}
          >
            <h1 className="m-0 shrink-0 whitespace-nowrap font-[inherit] text-[length:inherit]">
              {project?.kind === "scratch" ? "Make something from" : "Make something in"}
              <span className="sr-only">
                {project
                  ? ` ${project.kind === "scratch" ? "scratch" : projectLabel(project)}`
                  : ""}
              </span>
            </h1>
            <RepoPicker
              value={project}
              {...(workspaceName ? { workspaceName } : {})}
              repos={repos}
              {...(elsewhere ? { elsewhere } : {})}
              onChange={onProjectChange}
              onAllowMore={onAllowMore}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              after={() => field.current?.focus({ preventScroll: true })}
            />
          </div>
        </div>
      </div>
      <span className="min-h-10 flex-1" />
      <div
        ref={dock}
        data-create-dock
        // Away while it travels to the thread and lives there; held in its place for a send
        // that comes back.
        className={cn("mx-auto w-[660px] shrink-0", launched && "invisible")}
        style={{ paddingBottom: DOCK_INSET }}
      >
        <NewCanvasComposer
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
 * Where the hero goes (`heroPlace`), measured before the first paint and again whenever the pane,
 * the composer's dock or the statement change size. Null until first measured.
 */
function useHeroPlace(
  pane: RefObject<HTMLDivElement | null>,
  dock: RefObject<HTMLDivElement | null>,
  statement: RefObject<HTMLDivElement | null>,
): ReturnType<typeof heroPlace> | null {
  const [place, setPlace] = useState<ReturnType<typeof heroPlace> | null>(null);
  useLayoutEffect(() => {
    const p = pane.current;
    const d = dock.current;
    const s = statement.current;
    if (!p || !d || !s) return;
    const measure = () => {
      const next = heroPlace({
        pane: p.clientHeight,
        dock: d.offsetHeight,
        statement: s.offsetHeight,
      });
      setPlace((was) => (was?.top === next.top && was.mark === next.mark ? was : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(p);
    observer.observe(d);
    observer.observe(s);
    return () => observer.disconnect();
  }, [pane, dock, statement]);
  return place;
}
