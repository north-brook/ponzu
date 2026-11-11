import { Files01Icon, FolderGitIcon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { type KeyboardEvent, memo, useEffect, useRef, useState } from "react";
import type { DesignSummary } from "../model.ts";
import { type RowIndicator, rowIndicator } from "../status.ts";
import { AvatarStack } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { Slice } from "../ui/marks.tsx";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/menu.tsx";
import { JUMP_KEY } from "../ui/shortcut.ts";
import { HintKeys } from "../ui/shortcut-hint.tsx";
import { PullRequestMark } from "../window/pull-request-mark.tsx";
import { DesignPreviewImage } from "./design-preview.tsx";

export type RowAction = "copy_link" | "rename" | "settle" | "reopen" | "delete";

/** What a row does, the same for every row: pass the same functions each render. */
export interface RowHandlers {
  onOpen: (design: DesignSummary) => void;
  onAction: (design: DesignSummary, action: Exclude<RowAction, "rename">) => void;
  onRename: (design: DesignSummary, name: string) => void;
}

/**
 * A design in the sidebar: its preview, its name with one status at the end, and where it
 * lives (repo and branch, or a Scratch city) with its pull request. The open design's row takes
 * the selected ground (the canvas's, in light), and its pull request mark darkens and shows its checks. Teammates in it
 * now sit on the preview's corner. Right-click for its actions; Rename edits the name in place.
 * It draws again only when its own props change, so a long list stays quick. One of the first
 * nine shows its ⌘ number on the preview's corner while ⌘ is held.
 */
export const DesignRow = memo(function DesignRow({
  design,
  open,
  indicators = true,
  tabIndex,
  shortcut,
  hint = false,
  onOpen,
  onAction,
  onRename,
}: RowHandlers & {
  design: DesignSummary;
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
  // Back on the row once the name is done, so the keyboard carries on from where it was.
  useEffect(() => {
    if (renaming || !renamed.current) return;
    renamed.current = false;
    button.current?.focus();
  }, [renaming]);
  const indicator = indicators ? rowIndicator(design) : null;
  const pr = design.pullRequest;
  const settled = design.status === "settled";

  const body = (
    <>
      <span className="relative shrink-0">
        <DesignPreviewImage preview={design.preview} width={56} height={36} />
        {design.hereNow.length ? (
          <span className="absolute -right-[5px] -bottom-[5px] flex">
            <AvatarStack people={design.hereNow} size={15} overlap={5} ring="chrome" />
          </span>
        ) : null}
        {shortcut ? (
          <HintKeys
            jump="design"
            n={shortcut}
            shown={hint}
            tone="raised"
            className="top-[3px] left-[3px]"
          />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-[5px]">
          {renaming ? (
            <RenameField
              name={design.name}
              onDone={(name) => {
                renamed.current = true;
                setRenaming(false);
                if (name && name !== design.name) onRename(design, name);
              }}
            />
          ) : (
            <span className="truncate font-medium text-13">{design.name}</span>
          )}
          {indicator ? <IndicatorMark indicator={indicator} /> : null}
        </span>
        <span className="flex items-center gap-1.5 font-mono text-11 text-faint">
          <ProjectLine design={design} />
          {pr ? (
            <span className={cn("ml-auto flex", open && "text-muted")}>
              <PullRequestMark pr={pr} tone="neutral" checks={open} />
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
          data-design-row={design.id}
          aria-current={open ? "page" : undefined}
          aria-label={rowLabel(design, indicator)}
          aria-keyshortcuts={shortcut ? `${JUMP_KEY.design.key}+${shortcut}` : undefined}
          tabIndex={tabIndex}
          onClick={() => onOpen(design)}
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
        <ContextMenuItem onSelect={() => onAction(design, "copy_link")}>Copy link</ContextMenuItem>
        <ContextMenuItem onSelect={() => setRenaming(true)}>Rename</ContextMenuItem>
        {settled ? (
          <ContextMenuItem onSelect={() => onAction(design, "reopen")}>Reopen</ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onAction(design, "settle")}>Settle</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onAction(design, "delete")} className="text-danger">
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
});

/** Where a design lives: the repo and its branch, or Scratch's city. */
function ProjectLine({ design }: { design: DesignSummary }) {
  const { project } = design;
  if (project.kind === "scratch") {
    return (
      <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
        <Icon icon={Files01Icon} size={11} stroke={1.9} />
        <span className="truncate">{project.city}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
      <Icon icon={FolderGitIcon} size={11} stroke={1.9} />
      {project.repo.name}
      <span className="text-dry">·</span>
      <Icon icon={GitBranchIcon} size={10} stroke={2} />
      <span className="truncate">{project.branch}</span>
    </span>
  );
}

/** The one status mark, centred on the New design icon's line above it. */
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
      aria-label="Design name"
      defaultValue={name}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => finish(e.currentTarget.value.trim())}
      onKeyDown={onKeyDown}
      className="-mx-1 min-w-0 flex-1 rounded-4 bg-surface px-1 font-medium text-13 text-ink shadow-focus outline-none [caret-color:var(--c-yuzu)]"
    />
  );
}

function rowLabel(design: DesignSummary, indicator: RowIndicator | null): string {
  const parts = [design.name];
  if (indicator?.kind === "needs_you") parts.push(`${indicator.count} waiting for you`);
  if (indicator?.kind === "working") parts.push("working");
  if (indicator?.kind === "unseen") parts.push("new activity");
  const { project } = design;
  parts.push(
    project.kind === "repo"
      ? `${project.repo.name}, ${project.branch}`
      : `Scratch, ${project.city}`,
  );
  if (design.pullRequest) parts.push(`pull request #${design.pullRequest.number}`);
  return parts.join(", ");
}
