import { ArrowDown01Icon, ArrowUpRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { type Ref, useLayoutEffect, useRef, useState } from "react";
import type { Repo } from "../model.ts";
import { Button } from "../ui/button.tsx";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command.tsx";
import { menuSeparatorClass } from "../ui/dropdown-menu.tsx";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon, type IconSvgElement } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { REPO_ICON, SCRATCH_ICON } from "../ui/project-icons.ts";
import { Skeleton } from "../ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { type ProjectChoice, pickerRows, showsSearch } from "./create.ts";

const SCRATCH = "scratch";
const keyOf = (choice: ProjectChoice) => (choice.kind === "scratch" ? SCRATCH : choice.repo.id);

/**
 * The one choice under the composer: the repo the design is made in, or Scratch. A quiet text
 * control at rest, a darker step while its picker is open. The picker (shadcn's combobox: a
 * popover holding a command) is one of the menus' family: one-line rows of Scratch, then the
 * repos the App can see by name, and a way to allow more on GitHub; a search over them once
 * there are enough to need one. Typing filters, the arrows move (Home and End to the ends),
 * Return chooses, Escape closes without changing. `repos` is null while they load.
 */
export function RepoPicker({
  value,
  repos,
  onChange,
  onAllowMore,
  open,
  onOpenChange,
  contentRef,
}: {
  value: ProjectChoice;
  repos: Repo[] | null;
  onChange: (choice: ProjectChoice) => void;
  onAllowMore: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The open list, for the page to measure what room it needs. */
  contentRef?: Ref<HTMLDivElement>;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="quiet"
          aria-label={`Project: ${chipLabel(value)}`}
          className="gap-1.5 px-[9px]"
        >
          <Icon icon={iconOf(value)} size={13} stroke={1.7} />
          {chipLabel(value)}
          <Icon icon={ArrowDown01Icon} size={11} stroke={2.2} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        width={260}
        side="bottom"
        align="start"
        sideOffset={8}
        alignOffset={-4}
        aria-label="Choose a repo"
        ref={contentRef}
        updatePositionStrategy="always"
        className="rounded-12 p-1.5"
      >
        <PickerBody
          value={value}
          repos={repos}
          onChoose={(choice) => {
            onChange(choice);
            onOpenChange(false);
          }}
          onAllowMore={onAllowMore}
        />
      </PopoverContent>
    </Popover>
  );
}

function chipLabel(choice: ProjectChoice): string {
  return choice.kind === "scratch" ? "Scratch" : choice.repo.name;
}

function iconOf(choice: ProjectChoice): IconSvgElement {
  return choice.kind === "scratch" ? SCRATCH_ICON : REPO_ICON;
}

function PickerBody({
  value,
  repos,
  onChoose,
  onAllowMore,
}: {
  value: ProjectChoice;
  repos: Repo[] | null;
  onChoose: (choice: ProjectChoice) => void;
  onAllowMore: () => void;
}) {
  const [query, setQuery] = useState("");
  // The highlighted row: the chosen one as it opens, then wherever the keys or pointer move it.
  const [active, setActive] = useState(keyOf(value));
  const search = showsSearch(repos);
  const rows = pickerRows(repos ?? [], search ? query : "");
  const list = useRef<HTMLDivElement>(null);
  // With no field to type in, the list takes focus as it opens: the keys still move the
  // highlight (cmdk listens on its root), and the list names the highlighted row.
  useLayoutEffect(() => {
    if (!search) list.current?.focus({ preventScroll: true });
  }, [search]);

  const chosen = keyOf(value);
  const row = (choice: ProjectChoice, name: string) => (
    <PickerRow
      key={keyOf(choice)}
      choice={choice}
      name={name}
      checked={keyOf(choice) === chosen}
      onChoose={onChoose}
    />
  );

  return (
    <>
      {/* Our own filter (pickerRows), so cmdk only drives the keyboard and the highlight. */}
      <Command shouldFilter={false} value={active} onValueChange={setActive} label="Choose a repo">
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
        <FadeScroll className="max-h-[320px]">
          <CommandList ref={list} label="Repositories">
            {rows.scratch ? row({ kind: "scratch" }, "Scratch") : null}
            {repos === null ? (
              <div
                role="status"
                aria-label="Loading repositories"
                className="flex h-8 items-center gap-[9px] px-2"
              >
                <Skeleton className="size-4 rounded-4" />
                <Skeleton className="h-2.5 w-2/5 rounded-3" />
              </div>
            ) : (
              rows.repos.map((repo) => row({ kind: "repo", repo }, repo.name))
            )}
            {repos !== null && !rows.scratch && !rows.repos.length ? (
              <p className="m-0 flex h-8 items-center px-2 text-13 text-muted">
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
        <GithubMark size={16} />
        <span className="min-w-0 flex-1 truncate">
          {repos?.length === 0 ? "Allow repositories on GitHub" : "Allow more on GitHub"}
        </span>
        <Icon icon={ArrowUpRight01Icon} size={12} stroke={2} className="text-faint" />
      </button>
    </>
  );
}

/**
 * One line: the project's icon, its name, and the check on the chosen one. A name cut short shows
 * whole in a tip just past the picker's edge while the pointer rests on it; the row's accessible
 * name is always the whole of it.
 */
function PickerRow({
  choice,
  name,
  checked,
  onChoose,
}: {
  choice: ProjectChoice;
  name: string;
  checked: boolean;
  onChoose: (choice: ProjectChoice) => void;
}) {
  const key = keyOf(choice);
  // How far right of the name the tip sits: past the picker's edge, by a tip's usual gap.
  const [tip, setTip] = useState<number | null>(null);
  const label = useRef<HTMLSpanElement>(null);
  const place = (open: boolean) => {
    const el = label.current;
    const picker = el?.closest('[data-slot="popover-content"]');
    if (!open || !el || !picker || el.scrollWidth <= el.clientWidth) return setTip(null);
    const gap = picker.getBoundingClientRect().right - el.getBoundingClientRect().right;
    setTip(Math.round(gap) + TIP_GAP);
  };
  return (
    <CommandItem value={key} data-choice={key} onSelect={() => onChoose(choice)}>
      <Icon icon={iconOf(choice)} size={16} stroke={1.7} className="text-muted" />
      {/* The name is the tip's trigger: cmdk keeps the row's own pointer handlers. */}
      <Tooltip open={tip !== null} onOpenChange={place}>
        <TooltipTrigger asChild>
          <span ref={label} className="min-w-0 flex-1 truncate">
            {name}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={tip ?? TIP_GAP}>
          {name}
        </TooltipContent>
      </Tooltip>
      {checked ? <Icon icon={Tick02Icon} size={14} stroke={2.2} className="text-ink" /> : null}
    </CommandItem>
  );
}

/** A tip's distance from what it names (the tooltip's own `sideOffset`). */
const TIP_GAP = 6;
