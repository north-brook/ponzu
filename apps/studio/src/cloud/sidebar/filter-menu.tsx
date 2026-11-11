import { FilterHorizontalIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import {
  type DesignFilter,
  isFiltering,
  isRepoChecked,
  type RepoCount,
  toggleRepo,
} from "../filter.ts";
import type { Person } from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu.tsx";

const EVERYONE = "everyone";

/**
 * Narrows the design list by who started a design (one person, or everyone) and by repo
 * (checkboxes, with how many designs each has). It changes the list as you choose and stays
 * open until you click away. A small yuzu dot on the icon says a filter is on. A personal
 * workspace has nobody else to filter by, so no Person section.
 */
export function FilterMenu({
  filter,
  onChange,
  me,
  teammates,
  repos,
}: {
  filter: DesignFilter;
  onChange: (filter: DesignFilter) => void;
  me: Person;
  /** Null in a personal workspace. */
  teammates: Person[] | null;
  repos: RepoCount[];
}) {
  const allRepos = repos.map((r) => r.repo.id);
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          label={isFiltering(filter) ? "Filter (on)" : "Filter"}
          className="relative h-[26px] w-6"
        >
          <Icon icon={FilterHorizontalIcon} size={15} stroke={1.9} />
          {isFiltering(filter) ? (
            <span className="absolute top-[3px] right-[2px] size-1.5 rounded-pill bg-yuzu shadow-[0_0_0_1.5px_var(--c-chrome)]" />
          ) : null}
        </IconButton>
      </MenuTrigger>
      <MenuContent width={240} side="bottom" align="start" sideOffset={8} alignOffset={-48}>
        {teammates ? (
          <>
            <MenuLabel>Person</MenuLabel>
            <MenuRadioGroup
              value={filter.person ?? EVERYONE}
              onValueChange={(v) => onChange({ ...filter, person: v === EVERYONE ? null : v })}
            >
              <MenuRadioItem
                value={EVERYONE}
                onSelect={(e) => e.preventDefault()}
                leading={
                  <span className="grid size-5 shrink-0 place-items-center rounded-pill bg-hover text-muted">
                    <Icon icon={UserGroupIcon} size={13} stroke={1.8} />
                  </span>
                }
              >
                Everyone
              </MenuRadioItem>
              {[me, ...teammates].map((person) => (
                <MenuRadioItem
                  key={person.id}
                  value={person.id}
                  onSelect={(e) => e.preventDefault()}
                  leading={<Avatar person={person} size={20} />}
                >
                  {person.id === me.id ? "You" : person.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {repos.length ? <MenuSeparator /> : null}
          </>
        ) : null}
        {repos.length ? (
          <>
            <MenuLabel>Repo</MenuLabel>
            {repos.map(({ repo, count }) => (
              <MenuCheckboxItem
                key={repo.id}
                checked={isRepoChecked(filter, repo.id)}
                onCheckedChange={() => onChange(toggleRepo(filter, repo.id, allRepos))}
                trailing={
                  <span className="font-mono text-11 text-faint leading-none">{count}</span>
                }
              >
                {repo.name}
              </MenuCheckboxItem>
            ))}
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
