import type { ReactNode } from "react";
import type { Contributor, DesignMember, PageTab, PullRequestSummary, Repo } from "../model.ts";
import type { NextAction } from "../pull-request.ts";
import type { RailSignal } from "../status.ts";
import { cn } from "../ui/cn.ts";
import { Popover, PopoverAnchor } from "../ui/popover.tsx";
import { ChromeDivider } from "./chrome.tsx";
import { NextActionButton } from "./next-action.tsx";
import { PageTabs } from "./page-tabs.tsx";
import { Presence } from "./presence.tsx";
import { PullRequestTab } from "./pull-request-mark.tsx";
import { SharePopover } from "./share-popover.tsx";
import { ThreadToggle } from "./thread-toggle.tsx";

export interface DesignChromeProps {
  name: string;
  /** The design's name shows here only while the sidebar is collapsed: the open row says it otherwise. */
  sidebarOpen: boolean;
  pages: PageTab[];
  /** Null while the pull request tab is open. */
  activePageId: string | null;
  onSelectPage: (id: string) => void;
  /** Null for someone who may only look. */
  onAddPage: (() => void) | null;
  /** People on a repo design in a team workspace; null for Scratch and a personal workspace. */
  team: {
    meId: string;
    contributors: Contributor[];
    repo: Repo;
    members: DesignMember[];
    onOpenRepo: () => void;
  } | null;
  pullRequest: { pr: PullRequestSummary; tabOpen: boolean; onToggleTab: () => void } | null;
  action: {
    kind: NextAction;
    busy?: boolean;
    /** Why it can't be taken now (actionBlock), for its tip. */
    blocked?: string | null;
    onRun: (action: NextAction) => void;
  } | null;
  rail: { open: boolean; signal: RailSignal; onToggle: () => void };
}

/**
 * The chrome past the left block while a design is open: its pages, who is in it, its pull
 * request and next action, then the thread toggle just past the rail's divider. The spacing
 * between the right-hand pieces is the design's, whichever of them a design has.
 */
export function DesignChrome({
  name,
  sidebarOpen,
  pages,
  activePageId,
  onSelectPage,
  onAddPage,
  team,
  pullRequest,
  action,
  rail,
}: DesignChromeProps) {
  // Each piece, and the space that follows it before the next (or before the divider).
  const right: { key: string; node: ReactNode; after: number }[] = [];
  if (team) {
    right.push({
      key: "presence",
      node: <Presence contributors={team.contributors} meId={team.meId} />,
      after: 14,
    });
  }
  if (pullRequest) {
    right.push({
      key: "pr",
      node: (
        <PullRequestTab
          pr={pullRequest.pr}
          active={pullRequest.tabOpen}
          onToggle={pullRequest.onToggleTab}
        />
      ),
      after: 8,
    });
  }
  if (action) {
    right.push({
      key: "action",
      node: (
        <NextActionButton
          action={action.kind}
          busy={action.busy}
          blocked={action.blocked}
          onRun={action.onRun}
        />
      ),
      after: 10,
    });
  }

  // The board spaces them with spacers between 4px header gaps: a spacer of n is n + 8 here.
  const cluster = (
    <div className="flex shrink-0 items-center">
      {right.map(({ key, node, after }, i) => (
        <div key={key} className="flex items-center">
          {node}
          {i < right.length - 1 ? <span className="shrink-0" style={{ width: after + 8 }} /> : null}
        </div>
      ))}
    </div>
  );
  // After the last piece, 10 between two header gaps to the divider.
  const beforeDivider = right.length ? <span className="w-2.5 shrink-0" /> : null;

  return (
    <>
      <ChromeDivider />
      <span className="w-1 shrink-0" />
      {sidebarOpen ? null : (
        <span className="max-w-[240px] shrink-0 truncate pr-2 font-semibold text-13">{name}</span>
      )}
      <PageTabs pages={pages} activeId={activePageId} onSelect={onSelectPage} onAdd={onAddPage} />
      <span className="min-w-2 flex-1" />
      {team ? (
        <Popover>
          <PopoverAnchor asChild>{cluster}</PopoverAnchor>
          <SharePopover
            designName={name}
            repo={team.repo}
            members={team.members}
            meId={team.meId}
            onOpenRepo={team.onOpenRepo}
          />
        </Popover>
      ) : right.length ? (
        cluster
      ) : null}
      {beforeDivider}
      <ChromeDivider />
      <div
        className={cn(
          "flex shrink-0 items-center pl-2.5 transition-[width] duration-(--dur-pane) ease-out",
          rail.open ? "w-[346px]" : "w-auto",
        )}
      >
        <ThreadToggle open={rail.open} signal={rail.signal} onToggle={rail.onToggle} />
      </div>
    </>
  );
}
