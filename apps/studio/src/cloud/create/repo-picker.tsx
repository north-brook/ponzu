import {
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Files01Icon,
  FolderGitIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, type Ref, useState } from "react";
import type { Repo } from "../model.ts";
import { Button } from "../ui/button.tsx";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command.tsx";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { type ProjectChoice, pickerRows } from "./create.ts";

const SCRATCH = "scratch";
const keyOf = (choice: ProjectChoice) => (choice.kind === "scratch" ? SCRATCH : choice.repo.id);

/**
 * The one choice under the composer: the repo the design is made in, or Scratch. A quiet text
 * control at rest, a darker step while its picker is open. The picker (shadcn's combobox: a
 * popover holding a command) lists Scratch, then the repos the App can see by owner, with a
 * search over them and a way to allow more on GitHub. Typing filters, the arrow keys move (Home
 * and End to the ends), Return chooses, Escape closes without changing. `repos` is null while
 * they load.
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
          <Icon
            icon={value.kind === "scratch" ? Files01Icon : FolderGitIcon}
            size={13}
            stroke={1.7}
          />
          {chipLabel(value)}
          <Icon icon={ArrowDown01Icon} size={11} stroke={2.2} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        width={380}
        side="bottom"
        align="start"
        sideOffset={8}
        alignOffset={-4}
        aria-label="Choose a repo"
        ref={contentRef}
        updatePositionStrategy="always"
        className="p-1.5"
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
  const rows = pickerRows(repos ?? [], query);
  const listed = (rows.scratch ? 1 : 0) + rows.groups.reduce((n, g) => n + g.repos.length, 0);

  const chosen = keyOf(value);
  const row = (choice: ProjectChoice, icon: ReactNode, title: string, sub: string) => {
    const key = keyOf(choice);
    return (
      <CommandItem key={key} value={key} data-choice={key} onSelect={() => onChoose(choice)}>
        {icon}
        <span className="flex min-w-0 flex-col gap-px">
          <span className="truncate font-medium text-13">{title}</span>
          <span className="truncate font-mono text-11 text-faint">{sub}</span>
        </span>
        <span className="ml-auto" />
        {key === chosen ? (
          <Icon icon={Tick02Icon} size={14} stroke={2.2} className="text-ink" />
        ) : null}
      </CommandItem>
    );
  };

  return (
    <>
      {/* Our own filter (pickerRows), so cmdk only drives the keyboard and the highlight. */}
      <Command
        shouldFilter={false}
        value={active}
        onValueChange={setActive}
        label="Search repositories"
      >
        <CommandInput
          aria-label="Search repositories"
          placeholder="Search repositories"
          autoFocus
          value={query}
          onValueChange={setQuery}
        />
        <CommandSeparator alwaysRender className="mt-0.5 mb-1" />
        <FadeScroll className="max-h-[320px]">
          <CommandList label="Repositories">
            {rows.scratch
              ? row(
                  { kind: "scratch" },
                  <Icon icon={Files01Icon} size={15} stroke={1.7} className="text-muted" />,
                  "Scratch",
                  "no repo, kept in Ponzu",
                )
              : null}
            {repos === null ? (
              <div
                role="status"
                aria-label="Loading repositories"
                className="flex flex-col gap-2 px-2.5 py-2"
              >
                <Skeleton className="h-2.5 w-1/3 rounded-3" />
                <Skeleton className="h-2.5 w-1/2 rounded-3" />
              </div>
            ) : (
              rows.groups.map((group) => (
                <CommandGroup key={group.owner} heading={group.owner}>
                  {group.repos.map((repo) =>
                    row(
                      { kind: "repo", repo },
                      <Icon icon={FolderGitIcon} size={15} stroke={1.7} className="text-muted" />,
                      repo.name,
                      `${repo.owner}/${repo.name}`,
                    ),
                  )}
                </CommandGroup>
              ))
            )}
            {repos !== null && !listed ? (
              <p className="m-0 px-2.5 py-2 text-13 text-muted">
                No repositories match “{query.trim()}”
              </p>
            ) : null}
          </CommandList>
        </FadeScroll>
      </Command>
      <div className="mx-1.5 my-1 h-px bg-rule" />
      <button
        type="button"
        onClick={onAllowMore}
        className="flex cursor-default items-center gap-2.5 rounded-8 px-2.5 py-2 text-left text-13 text-ink outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover"
      >
        <GithubMark size={15} className="text-muted" />
        Allow more on GitHub
        <Icon icon={ArrowUpRight01Icon} size={12} stroke={2} className="ml-auto text-faint" />
      </button>
    </>
  );
}
