import type { DesignAccess, DesignMember, Repo } from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { ExternalLink } from "../ui/external-link.tsx";
import { FadeScroll } from "../ui/fade-scroll.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { PopoverContent } from "../ui/popover.tsx";

const ACCESS: Record<DesignAccess, string> = {
  owner: "Owner",
  edit: "Can edit",
  view: "Can view",
};

/**
 * Who can open this design. Access is the repo's on GitHub, so there is nothing to grant here:
 * the repo line opens it on GitHub, where people are added and removed. Every member is listed,
 * scrolling past 420px. Render it inside the Popover whose anchor is the chrome's right cluster.
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
        <ExternalLink onClick={onOpenRepo} stroke={1.5} className="self-start text-12">
          <GithubMark size={12} />
          <span className="font-mono text-11">
            {repo.owner}/{repo.name}
          </span>
        </ExternalLink>
      </div>
      <FadeScroll>
        <ul
          aria-label="People with access"
          className="m-0 flex list-none flex-col px-3 pt-0.5 pb-2"
        >
          {members.map(({ person, access }) => (
            <li key={person.id} className="flex items-center gap-2.5 px-1 py-1.5">
              <Avatar person={person} size={26} ring="surface" />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate font-medium text-13">
                  {person.name}
                  {person.id === meId ? (
                    <span className="font-normal text-faint"> (you)</span>
                  ) : null}
                </span>
                <span className="truncate font-mono text-11 text-faint">{person.login}</span>
              </div>
              <span className="shrink-0 text-12 text-muted">{ACCESS[access]}</span>
            </li>
          ))}
        </ul>
      </FadeScroll>
    </PopoverContent>
  );
}
