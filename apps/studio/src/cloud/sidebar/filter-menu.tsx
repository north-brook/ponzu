import { FilterMailIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import {
  type DesignFilter,
  isFiltering,
  isProjectChecked,
  type ProjectCount,
  toggleProject,
} from "../filter.ts";
import type { Person } from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { TEXT } from "../ui/ladder.ts";
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
 * Narrows the design list by who started a design (one person, or everyone) and by project
 * (checkboxes for each repo and Scratch, with how many designs each has). It changes the list as
 * you choose and stays open until you click away. A small yuzu dot on the icon says a filter is
 * on. A personal workspace has nobody else to filter by, so no Person section; with nothing to
 * choose either, there is no Filter at all.
 */
export function FilterMenu({
  filter,
  onChange,
  me,
  teammates,
  projects,
}: {
  filter: DesignFilter;
  onChange: (filter: DesignFilter) => void;
  me: Person;
  /** Null in a personal workspace. */
  teammates: Person[] | null;
  projects: ProjectCount[];
}) {
  if (!teammates && !projects.length) return null;
  const all = projects.map((p) => p.key);
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          label={isFiltering(filter) ? "Filter (on)" : "Filter"}
          className="relative h-[26px] w-6 shrink-0"
        >
          <Icon icon={FilterMailIcon} step="control" />
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
                    <Icon icon={UserGroupIcon} step="small" />
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
            {projects.length ? <MenuSeparator /> : null}
          </>
        ) : null}
        {projects.length ? (
          <>
            <MenuLabel>Repo</MenuLabel>
            {projects.map(({ key, repo, count }) => (
              <MenuCheckboxItem
                key={key}
                checked={isProjectChecked(filter, key)}
                onCheckedChange={() => onChange(toggleProject(filter, key, all))}
                trailing={<span className={cn("leading-none", TEXT.meta)}>{count}</span>}
              >
                {repo ? repo.name : "Scratch"}
              </MenuCheckboxItem>
            ))}
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
