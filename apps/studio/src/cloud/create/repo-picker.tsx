import {
  ArrowDown01Icon,
  ArrowUpRight01Icon,
  Files01Icon,
  FolderGitIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import type { Repo } from "../model.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { ScrollArea } from "../ui/scroll-area.tsx";
import { type ProjectChoice, pickerRows } from "./create.ts";

const SCRATCH = "scratch";
const keyOf = (choice: ProjectChoice) => (choice.kind === "scratch" ? SCRATCH : choice.repo.id);

/**
 * The one choice under the composer: the repo the design is made in, or Scratch. A quiet text
 * control at rest, a darker step while its picker is open. The picker lists Scratch, then the
 * repos the App can see by owner, with a search over them and a way to allow more on GitHub.
 * Typing filters, the arrow keys move, Return chooses, Escape closes without changing.
 * `repos` is null while they load.
 */
export function RepoPicker({
  value,
  repos,
  onChange,
  onAllowMore,
  open,
  onOpenChange,
}: {
  value: ProjectChoice;
  repos: Repo[] | null;
  onChange: (choice: ProjectChoice) => void;
  onAllowMore: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const rows = pickerRows(repos ?? [], query);
  const choices: ProjectChoice[] = [
    ...(rows.scratch ? [{ kind: "scratch" } as const] : []),
    ...rows.groups.flatMap((g) => g.repos.map((repo) => ({ kind: "repo", repo }) as const)),
  ];
  const keys = choices.map(keyOf);
  const [active, setActive] = useState(keyOf(value));
  // Keep the highlight on something that is still listed as the query narrows.
  useEffect(() => {
    if (!keys.includes(active) && keys[0]) setActive(keys[0]);
  }, [keys.join(), active]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const at = keys.indexOf(active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next =
        keys[Math.max(0, Math.min(keys.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const choice = choices[at];
      if (choice) onChoose(choice);
    }
  };

  const chosen = keyOf(value);
  const row = (choice: ProjectChoice, icon: ReactNode, title: string, sub: string) => {
    const key = keyOf(choice);
    return (
      // The search field keeps focus; rows are pointed at with aria-activedescendant.
      // biome-ignore lint/a11y/useKeyWithClickEvents: the field handles the keyboard
      <div
        key={key}
        id={`project-${key}`}
        role="option"
        tabIndex={-1}
        aria-selected={key === chosen}
        data-active={key === active || undefined}
        onMouseMove={() => setActive(key)}
        onClick={() => onChoose(choice)}
        className="flex cursor-default select-none items-center gap-2.5 rounded-8 px-2.5 py-[7px] data-active:bg-hover"
      >
        {icon}
        <span className="flex min-w-0 flex-col gap-px">
          <span className="truncate font-medium text-13">{title}</span>
          <span className="truncate font-mono text-11 text-faint">{sub}</span>
        </span>
        <span className="ml-auto" />
        {key === chosen ? (
          <Icon icon={Tick02Icon} size={14} stroke={2.2} className="text-ink" />
        ) : null}
      </div>
    );
  };

  return (
    <>
      <label className="flex h-[34px] items-center gap-2 px-2.5 text-13">
        <Icon icon={Search01Icon} size={14} stroke={1.7} className="text-faint" />
        <input
          role="combobox"
          aria-label="Search repositories"
          aria-expanded
          aria-controls="project-list"
          aria-activedescendant={keys.includes(active) ? `project-${active}` : undefined}
          placeholder="Search repositories"
          autoFocus
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-ink outline-none [caret-color:var(--c-yuzu)] placeholder:text-faint"
        />
      </label>
      <div className="mx-1.5 mt-0.5 mb-1 h-px bg-rule" />
      <ScrollArea className="max-h-[320px]">
        <div id="project-list" role="listbox" aria-label="Repositories" className="flex flex-col">
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
              className="breathe flex flex-col gap-2 px-2.5 py-2"
            >
              <span className="h-2.5 w-1/3 rounded-3 bg-hover" />
              <span className="h-2.5 w-1/2 rounded-3 bg-hover" />
            </div>
          ) : (
            rows.groups.map((group) => (
              // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group"
              <div
                key={group.owner}
                role="group"
                aria-label={group.owner}
                className="flex flex-col"
              >
                <span aria-hidden className="px-2.5 pt-2 pb-0.5 font-semibold text-11 text-faint">
                  {group.owner}
                </span>
                {group.repos.map((repo) =>
                  row(
                    { kind: "repo", repo },
                    <Icon icon={FolderGitIcon} size={15} stroke={1.7} className="text-muted" />,
                    repo.name,
                    `${repo.owner}/${repo.name}`,
                  ),
                )}
              </div>
            ))
          )}
          {repos !== null && !keys.length ? (
            <p className="m-0 px-2.5 py-2 text-13 text-muted">
              No repositories match “{query.trim()}”
            </p>
          ) : null}
        </div>
      </ScrollArea>
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
