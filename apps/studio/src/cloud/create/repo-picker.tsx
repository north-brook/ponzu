import { ArrowDown01Icon, ArrowUpRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Repo } from "../model.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command.tsx";
import { menuSeparatorClass } from "../ui/dropdown-menu.tsx";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { REPO_ICON, SCRATCH_ICON } from "../ui/project-icons.ts";
import { Skeleton } from "../ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import {
  type ProjectChoice,
  pickerRepos,
  pickerRows,
  projectLabel,
  type RepoRow,
  type RepoShelf,
  searchAtOpening,
} from "./create.ts";

const SCRATCH = "scratch";
const keyOf = (choice: ProjectChoice) => (choice.kind === "scratch" ? SCRATCH : choice.repo.id);

/**
 * The create page's project selector, in its header beside the logo: the repo the design is made
 * in (`owner/name`, the owner quieter so the name leads) or Scratch, in the display face, with a
 * chevron. It reads as part of the header, not as a chip, and has a quiet button's grounds.
 * `value` is null until the window's repos are known, and holds the selector's place meanwhile.
 *
 * The picker (shadcn's combobox: a popover holding a command) is one of the menus' family:
 * one-line rows of Scratch, then every repo the person can push to, the window's workspace's
 * first and then each other workspace's (`elsewhere`, as they arrive, after the rows already
 * there), each by its full name; and a way to allow more on GitHub for the window's workspace.
 * A search over them once there are enough to need one. Typing filters, the arrows move (Home
 * and End to the ends), Return chooses, Escape closes without changing. A repo in another
 * workspace is chosen with that workspace's id, for the window to switch to it.
 *
 * It opens under the selector and the page stays where it is: the list shows five and a half
 * rows and scrolls (a list that long has its search), and in a window too short even for that the
 * list gives up height rather than the picker turning over onto the composer.
 */
export function RepoPicker({
  value,
  repos,
  elsewhere = [],
  onChange,
  onAllowMore,
  open,
  onOpenChange,
}: {
  value: ProjectChoice | null;
  /** The window's workspace's repos; null while they load. */
  repos: Repo[] | null;
  /** The other workspaces' repos that have arrived, in the switcher's order. */
  elsewhere?: readonly RepoShelf[];
  /** `workspaceId` is null for Scratch and the window's own repos. */
  onChange: (choice: ProjectChoice, workspaceId: string | null) => void;
  onAllowMore: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const label = value ? projectLabel(value) : null;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="quiet"
          aria-label={label ? `Project: ${label}` : "Project"}
          aria-busy={label ? undefined : true}
          data-project-selector
          // The display face at the header's size; ink, so it stands beside the logo.
          className="h-10 min-w-0 max-w-full shrink gap-1 rounded-10 pr-1.5 pl-2 font-display font-semibold text-22 text-ink"
        >
          {value === null ? (
            <Skeleton className="h-3.5 w-[150px] rounded-4" />
          ) : value.kind === "scratch" ? (
            <span data-project-label className={cn("min-w-0 truncate", ON_THE_MARK)}>
              Scratch
            </span>
          ) : (
            <RepoTitle repo={value.repo} className={ON_THE_MARK} data-project-label />
          )}
          <Icon icon={ArrowDown01Icon} step="control" className="text-icon-soft" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        width={PICKER_WIDTH}
        side="bottom"
        align="start"
        sideOffset={6}
        // The rows' icons under the selector's first letter.
        alignOffset={-6}
        aria-label="Choose a repo"
        avoidCollisions={false}
        className="max-h-(--radix-popover-content-available-height) rounded-12 p-1.5"
      >
        <PickerBody
          value={value}
          repos={repos}
          elsewhere={elsewhere}
          onChoose={(choice, workspaceId) => {
            onChange(choice, workspaceId);
            onOpenChange(false);
          }}
          onAllowMore={onAllowMore}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * `owner/name` on one line, the owner and slash faint so the name leads. Cut short, the owner
 * gives way first (down to its ellipsis), and only then the name.
 */
function RepoTitle({
  repo,
  className,
  ...props
}: {
  repo: Repo;
  className?: string;
  "data-project-label"?: boolean;
}) {
  return (
    <span className={cn("flex min-w-0 items-baseline", className)} {...props}>
      <span className="min-w-[1em] shrink-[100] truncate text-faint">{repo.owner}</span>
      <span className="shrink-0 text-faint">/</span>
      <span className="min-w-0 truncate">{repo.name}</span>
    </span>
  );
}

function PickerBody({
  value,
  repos,
  elsewhere,
  onChoose,
  onAllowMore,
}: {
  value: ProjectChoice | null;
  repos: Repo[] | null;
  elsewhere: readonly RepoShelf[];
  onChoose: (choice: ProjectChoice, workspaceId: string | null) => void;
  onAllowMore: () => void;
}) {
  const [query, setQuery] = useState("");
  // The highlighted row: the chosen one as it opens, then wherever the keys or pointer move it.
  const [active, setActive] = useState(value ? keyOf(value) : SCRATCH);
  const all = pickerRepos(repos, elsewhere);
  // Whether there is a search is settled as the picker opens and holds while it is open: rows
  // arriving join at the foot, and a field brought in over them would move them. With repos still
  // to come (the window's, or another workspace's) it has one, as the list may come to scroll.
  const [search] = useState(() => repos === null || searchAtOpening(all.length, elsewhere));
  const rows = pickerRows(all, search ? query : "");
  const list = useRef<HTMLDivElement>(null);
  // With no field to type in, the list takes focus as it opens: the keys still move the
  // highlight (cmdk listens on its root), and the list names the highlighted row.
  useLayoutEffect(() => {
    if (!search) list.current?.focus({ preventScroll: true });
  }, [search]);

  const chosen = value ? keyOf(value) : null;
  const scratch: ProjectChoice = { kind: "scratch" };
  const row = (choice: ProjectChoice, workspaceId: string | null) => (
    <PickerRow
      key={keyOf(choice)}
      choice={choice}
      workspaceId={workspaceId}
      checked={keyOf(choice) === chosen}
      highlighted={keyOf(choice) === active}
      onChoose={onChoose}
    />
  );

  return (
    <>
      {/* Our own filter (pickerRows), so cmdk only drives the keyboard and the highlight. */}
      <Command
        shouldFilter={false}
        value={active}
        onValueChange={setActive}
        label="Choose a repo"
        className="min-h-0"
      >
        {search ? (
          <>
            <CommandInput
              aria-label="Search repositories"
              placeholder="Search repositories"
              autoFocus
              value={query}
              onValueChange={setQuery}
            />
            <CommandSeparator alwaysRender />
          </>
        ) : null}
        <FadeScroll style={{ maxHeight: LIST_ROOM }}>
          <CommandList ref={list} label="Repositories">
            {rows.scratch ? row(scratch, null) : null}
            {rows.repos.map(({ repo, workspaceId }: RepoRow) =>
              row({ kind: "repo", repo }, workspaceId),
            )}
            {repos === null ? (
              // The window's repos come first: while they load, their place is held under Scratch.
              <div
                role="status"
                aria-label="Loading repositories"
                className="flex h-8 items-center gap-[9px] px-2"
              >
                <Skeleton className="size-4 rounded-4" />
                <Skeleton className="h-2.5 w-2/5 rounded-3" />
              </div>
            ) : null}
            {repos !== null && !rows.scratch && !rows.repos.length ? (
              // In the names' column (past a 16px icon and its 9px gap), under the field's text.
              <p className="m-0 flex h-8 items-center pr-2 pl-[33px] text-13 text-muted">
                <span className="truncate">No repositories match “{query.trim()}”</span>
              </p>
            ) : null}
          </CommandList>
        </FadeScroll>
      </Command>
      {/* Past the command, where cmdk's separator can't go: the menus' own rule. */}
      <div aria-hidden className={menuSeparatorClass} />
      <button
        type="button"
        onClick={onAllowMore}
        className="flex h-8 shrink-0 cursor-default items-center gap-[9px] rounded-7 px-2 text-left text-13 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover"
      >
        {/* Faint, like the arrow: the solid mark would outweigh the stroked icons it serves. */}
        <GithubMark size={16} className="text-faint" />
        <span className="min-w-0 flex-1 truncate">
          {repos?.length === 0 ? "Allow repositories on GitHub" : "Allow more on GitHub"}
        </span>
        <Icon icon={ArrowUpRight01Icon} step="small" className="text-faint" />
      </button>
    </>
  );
}

/**
 * One line: the project's icon, its full name, and the check on the chosen one. A name cut short
 * shows whole in a tip just past the picker's edge while the pointer rests on it, or while the
 * arrows have it highlighted (not as the picker opens on it: only once the highlight moves
 * there); the row's accessible name is always the whole of it.
 */
function PickerRow({
  choice,
  workspaceId,
  checked,
  highlighted,
  onChoose,
}: {
  choice: ProjectChoice;
  workspaceId: string | null;
  checked: boolean;
  highlighted: boolean;
  onChoose: (choice: ProjectChoice, workspaceId: string | null) => void;
}) {
  const key = keyOf(choice);
  const name = projectLabel(choice);
  // Which side of the name the tip sits, and how far from it: past the picker's edge by a tip's
  // usual gap, on the right where the window has room for it, else on the left.
  const [tip, setTip] = useState<{ side: "right" | "left"; offset: number } | null>(null);
  const label = useRef<HTMLSpanElement>(null);
  const place = (open: boolean) => {
    const el = label.current;
    const picker = el?.closest('[data-slot="popover-content"]');
    if (!open || !el || !picker || !cutShort(el)) return setTip(null);
    const p = picker.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (window.innerWidth - p.right - TIP_GAP - TIP_ROOM >= wholeWidth(el)) {
      setTip({ side: "right", offset: Math.round(p.right - r.right) + TIP_GAP });
    } else {
      setTip({ side: "left", offset: Math.round(r.left - p.left) + TIP_GAP });
    }
  };
  // The highlight, wherever the keys or the pointer move it, opens and closes the tip too.
  const was = useRef(highlighted);
  useEffect(() => {
    if (was.current === highlighted) return;
    was.current = highlighted;
    place(highlighted);
    if (!highlighted) return;
    // The list scrolls a row the keys reach into view, and a tip closes when what it names
    // scrolls: once that has happened, the row still highlighted gets its tip back.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => was.current && place(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [highlighted]);
  return (
    <CommandItem
      value={key}
      data-choice={key}
      {...(workspaceId ? { "data-workspace": workspaceId } : {})}
      onSelect={() => onChoose(choice, workspaceId)}
    >
      <Icon
        icon={choice.kind === "scratch" ? SCRATCH_ICON : REPO_ICON}
        step="control"
        className="text-muted"
      />
      {/* The name is the tip's trigger: cmdk keeps the row's own pointer handlers. */}
      <Tooltip open={tip !== null} onOpenChange={place}>
        <TooltipTrigger asChild>
          <span ref={label} className="flex min-w-0 flex-1">
            {choice.kind === "scratch" ? (
              <span className="min-w-0 truncate">{name}</span>
            ) : (
              <RepoTitle repo={choice.repo} />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side={tip?.side ?? "right"}
          sideOffset={tip?.offset ?? TIP_GAP}
          // The side is chosen above, knowing where the picker's edges are; Radix's own flip
          // would keep the offset meant for the other side.
          avoidCollisions={false}
        >
          {name}
        </TooltipContent>
      </Tooltip>
      {checked ? <Icon icon={Tick02Icon} step="inline" className="text-ink" /> : null}
    </CommandItem>
  );
}

/** Whether any part of a title is cut short by its ellipsis. */
function cutShort(el: Element): boolean {
  const parts = el.querySelectorAll<HTMLElement>("span");
  return [el as HTMLElement, ...parts].some((part) => part.scrollWidth > part.clientWidth);
}

/** A title's width uncut: each of its parts' whole width. */
function wholeWidth(el: Element): number {
  const parts = [...el.querySelectorAll<HTMLElement>("span")].filter(
    (s) => !s.querySelector("span"),
  );
  return parts.reduce((sum, part) => sum + part.scrollWidth, 0);
}

/** A tip's own padding and the least margin it keeps from the window's edge, past its words. */
const TIP_ROOM = 32;

/**
 * The selector's words sit on the row's line (the logo's mark's centre) by the centre of their
 * x-height, as the logo's word does, rather than by the middle of their line box, which in Funnel
 * Display at 22 is 2.4 lower: so their box, centred on the line, keeps 5 of room under them.
 */
const ON_THE_MARK = "pb-[5px]";

/** Wide enough for most full names; one cut short shows whole in its tip. */
const PICKER_WIDTH = 340;

/**
 * What the list shows before it scrolls: five 32px rows and half of the next, so a longer list
 * reads as longer.
 */
const LIST_ROOM = 176;

/** A tip's distance from what it names (the tooltip's own `sideOffset`). */
const TIP_GAP = 6;
