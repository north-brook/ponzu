import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { DesignAccess, DesignMember, Repo } from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { PopoverContent } from "../ui/popover.tsx";

const ACCESS: Record<DesignAccess, string> = {
  owner: "Owner",
  edit: "Can edit",
  view: "Can view",
};

/** Under the login of someone GitHub gives access who hasn't opened Ponzu. */
const NOT_JOINED_SHORT = "hasn't opened Ponzu yet";

/**
 * Who can open this design. Access is the repo's on GitHub, so there is nothing to grant here:
 * the repo line opens it on GitHub, where people are added and removed. Everyone with access is
 * listed, scrolling past 420px; someone who hasn't opened Ponzu yet is quieter, and says so
 * under their login. Render it inside the Popover whose anchor is the chrome's right cluster.
 */
export function SharePopover({
  designName,
  repo,
  members,
  meId,
  onOpenRepo,
}: {
  designName: string;
  repo: Repo;
  members: DesignMember[];
  meId: string;
  onOpenRepo: () => void;
}) {
  return (
    <PopoverContent
      width={360}
      side="bottom"
      align="end"
      sideOffset={10}
      alignOffset={-3}
      aria-label={`Share ${designName}`}
      className="max-h-[420px]"
    >
      <div className="flex flex-col gap-[7px] px-4 pt-4 pb-2">
        <h2 className="m-0 font-semibold text-14">Share {designName}</h2>
        <button
          type="button"
          onClick={onOpenRepo}
          className="-mx-1 flex cursor-default items-center gap-1.5 self-start rounded-6 px-1 text-12 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:bg-hover"
        >
          <GithubMark size={12} />
          <span className="font-mono text-11">
            {repo.owner}/{repo.name}
          </span>
          <Icon icon={ArrowUpRight01Icon} size={11} stroke={1.5} className="text-icon-soft" />
        </button>
      </div>
      <FadeScroll>
        <ul
          aria-label="People with access"
          className="m-0 flex list-none flex-col px-3 pt-0.5 pb-2"
        >
          {members.map(({ person, access, joined }) => (
            <li key={person.id} className="flex items-center gap-2.5 px-1 py-1.5">
              <Avatar
                person={person}
                size={26}
                ring="surface"
                className={joined ? undefined : "opacity-50"}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className={cn("truncate font-medium text-13", !joined && "text-muted")}>
                  {person.name}
                  {person.id === meId ? (
                    <span className="font-normal text-faint"> (you)</span>
                  ) : null}
                </span>
                <span className="truncate text-11 text-faint">
                  <span className="font-mono">{person.login}</span>
                  {joined ? null : ` · ${NOT_JOINED_SHORT}`}
                </span>
              </div>
              <span className={cn("shrink-0 text-12", joined ? "text-muted" : "text-faint")}>
                {ACCESS[access]}
              </span>
            </li>
          ))}
        </ul>
      </FadeScroll>
    </PopoverContent>
  );
}
