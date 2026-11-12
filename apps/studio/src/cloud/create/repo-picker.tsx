import { ArrowDown01Icon, ArrowUpRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Repo } from "../model.ts";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import {
  Command,
  CommandGroup,
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
  heldWhileOpen,
  LIST_ROOM,
  type PickerGroup,
  type ProjectChoice,
  pickerGroups,
  projectLabel,
  projectName,
  type RepoShelf,
  type Shelf,
  searchAtOpening,
} from "./create.ts";

const SCRATCH = "scratch";
/** A row's key: the window's Scratch is `scratch`, another workspace's `scratch:<its id>`. */
const keyOf = (choice: ProjectChoice, workspaceId: string | null) =>
  choice.kind === "repo" ? choice.repo.id : workspaceId ? `${SCRATCH}:${workspaceId}` : SCRATCH;

/**
 * The create page's project selector, in its header beside the logo: the repo the design is made
 * in (`owner/name`, the owner quieter so the name leads) or Scratch, in the display face, with a
 * chevron. It reads as part of the header, not as a chip, and has a quiet button's grounds.
 * `value` is null until the window's repos are known, and holds the selector's place meanwhile.
 *
 * The picker (shadcn's combobox: a popover holding a command) is one of the menus' family. With
 * one workspace it is one-line rows of Scratch, then every repo the person can push to, each by
 * its full name. With several, a group for each, the window's first and then the others in the
 * switcher's order (`elsewhere`): the workspace's name over it as a menu's section label, its
 * Scratch, and its repos as they arrive (pickerGroups and heldWhileOpen in create.ts). Under them,
 * a way to allow more on GitHub for the window's workspace. A search over them whenever the list
 * would scroll. Typing filters, the arrows move over the rows (Home and End to the ends), Return
 * chooses, Escape closes without changing. A project in another workspace, its Scratch or a repo,
 * is chosen with that workspace's id, for the window to switch to it.
 *
 * It opens under the selector and the page stays where it is: the list shows five and a half
 * rows and scrolls (a list that long has its search), and in a window too short even for that the
 * list gives up height rather than the picker turning over onto the composer.
 */
export function RepoPicker({
  value,
  workspaceName = null,
  repos,
  elsewhere = [],
  onChange,
  onAllowMore,
  open,
  onOpenChange,
}: {
  value: ProjectChoice | null;
  /** The window's workspace's name: its group's heading, and whose Scratch the selector says. */
  workspaceName?: string | null;
  /** The window's workspace's repos; null while they load. */
  repos: Repo[] | null;
  /** Each other usable workspace, in the switcher's order, with its repos once they arrive. */
  elsewhere?: readonly RepoShelf[];
  /** `workspaceId` is null for the window's own Scratch and repos. */
  onChange: (choice: ProjectChoice, workspaceId: string | null) => void;
  onAllowMore: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="quiet"
          aria-label={value ? projectName(value, workspaceName) : "Project"}
          aria-busy={value ? undefined : true}
          data-project-selector
          // The last words of the create page's statement: its face, size and baseline.
          className="h-10 min-w-0 shrink items-baseline gap-1.5 rounded-10 pr-1.5 pl-2 font-[inherit] text-[length:inherit] text-ink"
        >
          {value === null ? (
            <Skeleton className="h-4 w-[150px] self-center rounded-4" />
          ) : value.kind === "scratch" ? (
            <span data-project-label className="min-w-0 truncate">
              scratch
            </span>
          ) : (
            <RepoTitle repo={value.repo} data-project-label />
          )}
          <Icon icon={ArrowDown01Icon} step="control" className="self-center text-icon-soft" />
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
          workspaceName={workspaceName}
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
  workspaceName,
  repos,
  elsewhere,
  onChoose,
  onAllowMore,
}: {
  value: ProjectChoice | null;
  workspaceName: string | null;
  repos: Repo[] | null;
  elsewhere: readonly RepoShelf[];
  onChoose: (choice: ProjectChoice, workspaceId: string | null) => void;
  onAllowMore: () => void;
}) {
  const [query, setQuery] = useState("");
  // The highlighted row: the chosen one as it opens, then wherever the keys or pointer move it.
  const [active, setActive] = useState(value ? keyOf(value, null) : SCRATCH);
  const now: Shelf[] = [{ workspaceId: null, name: workspaceName ?? "", repos }, ...elsewhere];
  // What each workspace had as the picker opened: only the last one's repos join while it is
  // open, at the foot, so nothing moves under the pointer.
  const [atOpening] = useState(now);
  const shelves = heldWhileOpen(atOpening, now);
  // Whether there is a search is settled as the picker opens and holds while it is open: a field
  // brought in over the rows would move them. It has one whenever the list would scroll, or may
  // come to (the last workspace's repos still to come).
  const [search] = useState(() => searchAtOpening(pickerGroups(shelves, "")));
  const groups = pickerGroups(shelves, search ? query : "");
  const list = useRef<HTMLDivElement>(null);
  // With no field to type in, the list takes focus as it opens: the keys still move the
  // highlight (cmdk listens on its root), and the list names the highlighted row.
  useLayoutEffect(() => {
    if (!search) list.current?.focus({ preventScroll: true });
  }, [search]);

  const chosen = value ? keyOf(value, null) : null;
  const scratch: ProjectChoice = { kind: "scratch" };
  const row = (choice: ProjectChoice, workspaceId: string | null) => (
    <PickerRow
      key={keyOf(choice, workspaceId)}
      choice={choice}
      workspaceId={workspaceId}
      checked={keyOf(choice, workspaceId) === chosen}
      highlighted={keyOf(choice, workspaceId) === active}
      onChoose={onChoose}
    />
  );
  const rows = (group: PickerGroup) => (
    <>
      {group.scratch ? row(scratch, group.workspaceId) : null}
      {group.repos.map((repo) => row({ kind: "repo", repo }, group.workspaceId))}
      {group.loading ? (
        // Its place held under its Scratch while the workspace's repos are coming.
        <div
          role="status"
          aria-label="Loading repositories"
          className="flex h-8 shrink-0 items-center gap-[9px] px-2"
        >
          <Skeleton className="size-4 rounded-4" />
          <Skeleton className="h-2.5 w-2/5 rounded-3" />
        </div>
      ) : null}
    </>
  );

  return (
    <>
      {/* Our own filter (pickerGroups), so cmdk only drives the keyboard and the highlight. */}
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
            {groups.map((group, i) =>
              group.heading === null ? (
                <Fragment key={group.workspaceId ?? SCRATCH}>{rows(group)}</Fragment>
              ) : (
                <Fragment key={group.workspaceId ?? SCRATCH}>
                  {/* The menus' rule between sections; drawn while a search is typed too. */}
                  {i > 0 ? <CommandSeparator alwaysRender /> : null}
                  <CommandGroup heading={group.heading}>{rows(group)}</CommandGroup>
                </Fragment>
              ),
            )}
            {!groups.length ? (
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
  const key = keyOf(choice, workspaceId);
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
      // The title is three spans in a flex line, which the browser would name with spaces
      // between them ("maya / kettle"): the row is named by the whole of it.
      aria-label={name}
      data-choice={key}
      {...(checked ? { "data-checked": true } : {})}
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
 * Wide enough for most full names (one cut short shows whole in its tip), and ending on the
 * composer's right edge: the selector starts 8 past the hairline's centre, which is the column's
 * (half of 660, less half the hairline's pixel), and the picker 6 before the selector.
 */
const PICKER_WIDTH = 330 - 0.5 - 8 + 6;

/** A tip's distance from what it names (the tooltip's own `sideOffset`). */
const TIP_GAP = 6;
