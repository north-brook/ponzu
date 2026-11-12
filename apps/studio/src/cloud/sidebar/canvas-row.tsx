import {
  ArrowTurnBackwardIcon,
  Delete02Icon,
  GitBranchIcon,
  Link01Icon,
  PencilEdit01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type KeyboardEvent, memo, useEffect, useRef, useState } from "react";
import type { CanvasSummary } from "../model.ts";
import { pullRequestIcon } from "../pull-request.ts";
import { type RowIndicator, rowIndicator } from "../status.ts";
import { AvatarStack } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { TEXT } from "../ui/ladder.ts";
import { Slice } from "../ui/marks.tsx";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/menu.tsx";
import { REPO_ICON, SCRATCH_ICON } from "../ui/project-icons.ts";
import { JUMP_KEY } from "../ui/shortcut.ts";
import { HintKeys } from "../ui/shortcut-hint.tsx";
import { PULL_REQUEST_ICONS } from "../window/pull-request-mark.tsx";
import { CanvasPreviewImage } from "./canvas-preview.tsx";

export type RowAction = "copy_link" | "rename" | "settle" | "reopen" | "delete";

/** What a row does, the same for every row: pass the same functions each render. */
export interface RowHandlers {
  onOpen: (canvas: CanvasSummary) => void;
  onAction: (canvas: CanvasSummary, action: Exclude<RowAction, "rename">) => void;
  onRename: (canvas: CanvasSummary, name: string) => void;
  /**
   * The person is about to open it: the pointer has come to rest on the row, or the keyboard is
   * on it. What opening it will ask for can be asked ahead.
   */
  onIntent?: (canvas: CanvasSummary) => void;
}

/** How long the pointer or the keyboard rests on a row before it counts as about to open it. */
export const INTENT_MS = 80;

/**
 * A design in the sidebar: its preview beside three lines. The first says where it lives (the
 * repo, or Scratch) with one status at its end; the second is its name; the third is its branch
 * (or Scratch's city) with its pull request at the end, set the same quiet way as the repo and
 * the branch. The open design's row takes the selected ground (the canvas's, in light).
 * Teammates in it now sit on the preview's corner. Right-click for its actions; Rename edits
 * the name in place. It draws again only when its own props change, so a long list stays quick.
 * One of the first nine shows its ⌘ number on the preview's corner while ⌘ is held.
 */
export const CanvasRow = memo(function CanvasRow({
  canvas,
  open,
  indicators = true,
  tabIndex,
  shortcut,
  hint = false,
  onOpen,
  onAction,
  onRename,
  onIntent,
}: RowHandlers & {
  canvas: CanvasSummary;
  open: boolean;
  /** Settled rows show none. */
  indicators?: boolean;
  tabIndex: number;
  /** The ⌘ number that opens it (sidebar order), if one does. */
  shortcut?: number;
  /** ⌘ is held: the number shows. */
  hint?: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const renamed = useRef(false);
  const resting = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rest = () => {
    if (resting.current) clearTimeout(resting.current);
    resting.current = null;
  };
  const intend = () => {
    rest();
    if (!onIntent || open) return;
    resting.current = setTimeout(() => onIntent(canvas), INTENT_MS);
  };
  useEffect(() => rest, []);
  // Opened: what it would have asked ahead, opening asks itself.
  useEffect(() => {
    if (open && resting.current) {
      clearTimeout(resting.current);
      resting.current = null;
    }
  }, [open]);
  // Back on the row once the name is done, so the keyboard carries on from where it was.
  useEffect(() => {
    if (renaming || !renamed.current) return;
    renamed.current = false;
    button.current?.focus();
  }, [renaming]);
  const indicator = indicators ? rowIndicator(canvas) : null;
  const pr = canvas.pullRequest;
  const { project } = canvas;
  const settled = canvas.status === "settled";

  const body = (
    <>
      <span className="relative shrink-0">
        <CanvasPreviewImage preview={canvas.preview} width={64} height={48} />
        {canvas.hereNow.length ? (
          <span className="absolute -right-[5px] -bottom-[5px] flex">
            <AvatarStack people={canvas.hereNow} size={15} overlap={5} ring="chrome" />
          </span>
        ) : null}
        {shortcut ? (
          <HintKeys
            jump="canvas"
            n={shortcut}
            shown={hint}
            tone="raised"
            className="top-[3px] left-[3px]"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className={META}>
          <Meta
            icon={project.kind === "repo" ? REPO_ICON : SCRATCH_ICON}
            text={project.kind === "repo" ? project.repo.name : "Scratch"}
          />
          {indicator ? <IndicatorMark indicator={indicator} /> : null}
        </span>
        {renaming ? (
          <RenameField
            name={canvas.name}
            onDone={(name) => {
              renamed.current = true;
              setRenaming(false);
              if (name && name !== canvas.name) onRename(canvas, name);
            }}
          />
        ) : (
          <span className="truncate font-medium text-13">{canvas.name}</span>
        )}
        <span className={META}>
          {project.kind === "repo" ? (
            <Meta icon={GitBranchIcon} text={project.branch} />
          ) : (
            <span className="truncate">{project.city}</span>
          )}
          {pr ? (
            <span className="ml-auto flex shrink-0 items-center gap-1 pl-1.5">
              <Icon icon={PULL_REQUEST_ICONS[pullRequestIcon(pr)]} step="meta" />#{pr.number}
            </span>
          ) : null}
        </span>
      </span>
    </>
  );

  const rowClass = cn(
    "flex w-full items-center gap-2.5 rounded-8 px-2 py-1.5 text-left text-ink outline-none transition-colors duration-(--dur-hover)",
    open ? "bg-selected" : "hover:bg-hover",
  );

  if (renaming) return <div className={rowClass}>{body}</div>;

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <button
          ref={button}
          type="button"
          data-canvas-row={canvas.id}
          aria-current={open ? "page" : undefined}
          aria-label={rowLabel(canvas, indicator)}
          aria-keyshortcuts={shortcut ? `${JUMP_KEY.canvas.key}+${shortcut}` : undefined}
          tabIndex={tabIndex}
          onClick={() => onOpen(canvas)}
          // Resting there, not passing over or through it (a sweep of the pointer, the arrow
          // keys down the list): only a row the person stops on is asked about ahead.
          onPointerEnter={intend}
          onPointerLeave={rest}
          onFocus={intend}
          onBlur={rest}
          className={cn(
            rowClass,
            "cursor-default select-none focus-ring active:bg-press",
            open && "active:bg-selected",
          )}
        >
          {body}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent width={200}>
        <ContextMenuItem
          leading={<MenuIcon icon={Link01Icon} />}
          onSelect={() => onAction(canvas, "copy_link")}
        >
          Copy link
        </ContextMenuItem>
        <ContextMenuItem
          leading={<MenuIcon icon={PencilEdit01Icon} />}
          onSelect={() => setRenaming(true)}
        >
          Rename
        </ContextMenuItem>
        {settled ? (
          <ContextMenuItem
            leading={<MenuIcon icon={ArrowTurnBackwardIcon} />}
            onSelect={() => onAction(canvas, "reopen")}
          >
            Reopen
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            leading={<MenuIcon icon={Tick02Icon} />}
            onSelect={() => onAction(canvas, "settle")}
          >
            Settle
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          leading={<Icon icon={Delete02Icon} step="control" />}
          onSelect={() => onAction(canvas, "delete")}
          className="text-danger"
        >
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
});

/** An action's icon in the row's menu, as the workspace menu sets its own. */
function MenuIcon({ icon }: { icon: Parameters<typeof Icon>[0]["icon"] }) {
  return <Icon icon={icon} step="control" className="text-muted" />;
}

/** A line of a row's quiet facts: the repo, the branch, the pull request. */
const META = `flex h-[14px] items-center gap-1.5 ${TEXT.meta}`;

/** One of them: a small icon and its word, cut short when the row is narrow. */
function Meta({ icon, text }: { icon: Parameters<typeof Icon>[0]["icon"]; text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
      <Icon icon={icon} step="meta" />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** The one status mark, at the end of the row's first line. */
function IndicatorMark({ indicator }: { indicator: RowIndicator }) {
  if (indicator.kind === "needs_you") {
    const label = `${indicator.count} ${indicator.count === 1 ? "question" : "questions"} for you`;
    return (
      <span
        title={label}
        className="-mr-[3px] ml-auto grid h-3.5 min-w-3.5 shrink-0 place-items-center rounded-pill bg-yuzu px-[3px] font-semibold text-9 text-yuzu-ink leading-none"
      >
        {indicator.count}
      </span>
    );
  }
  if (indicator.kind === "working") {
    return (
      <span className="-mr-[3px] ml-auto grid w-3.5 shrink-0 place-items-center text-yuzu">
        <Slice size={13} turning label="Working" />
      </span>
    );
  }
  return (
    <span
      title="New activity"
      className="mr-[0.5px] ml-auto size-[7px] shrink-0 rounded-pill bg-yuzu shadow-dot"
    />
  );
}

/** Return or leaving the field keeps the new name; Escape keeps the old one. */
function RenameField({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") finish(e.currentTarget.value.trim());
    if (e.key === "Escape") finish(null);
  };
  return (
    <input
      aria-label="Canvas name"
      // ⌘B leaves the sidebar open while its name is being edited (paneHeld).
      data-holds-pane
      defaultValue={name}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value.trim())}
      onKeyDown={onKeyDown}
      className="-mx-1 min-w-0 flex-1 rounded-4 bg-surface px-1 font-medium text-13 text-ink shadow-focus outline-none [caret-color:var(--c-yuzu)]"
    />
  );
}

function rowLabel(canvas: CanvasSummary, indicator: RowIndicator | null): string {
  const parts = [canvas.name];
  if (indicator?.kind === "needs_you") parts.push(`${indicator.count} waiting for you`);
  if (indicator?.kind === "working") parts.push("working");
  if (indicator?.kind === "unseen") parts.push("new activity");
  const { project } = canvas;
  parts.push(
    project.kind === "repo"
      ? `${project.repo.name}, ${project.branch}`
      : `Scratch, ${project.city}`,
  );
  if (canvas.pullRequest) parts.push(`pull request #${canvas.pullRequest.number}`);
  return parts.join(", ");
}
