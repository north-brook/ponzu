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
 * The chrome past the left block while a design is open: its name while the sidebar is
 * collapsed, the divider, its pages, then at the window's right
 * edge who is in it, its pull request and next action, and the thread toggle last. The spacing
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
  return (
    <>
      {/*
       * The design's name, then the divider. Collapsed, the name sits just past the sidebar
       * toggle (set as the row sets it, cut at 240) and the divider just past it; open, the row
       * says the name, so its room closes to nothing and the divider lands on the sidebar's edge.
       * The room opens and closes on the panes' clock, with the left block before it. A part of
       * the title bar, not a control: a double-click zooms the window there, as on any Mac
       * window, so renaming stays on the row.
       */}
      <span className="flex shrink-0 items-center">
        <span
          aria-hidden={sidebarOpen}
          data-chrome-title
          className={cn(
            // Hidden once its room has closed (visibility waits out the transition).
            "pane-motion flex overflow-hidden transition-[width,opacity,visibility]",
            sidebarOpen ? "invisible w-0 opacity-0" : "w-auto",
          )}
        >
          <span className="max-w-[240px] truncate pr-3 pl-1 font-medium text-13 text-ink">
            {name}
          </span>
        </span>
        <ChromeDivider />
      </span>
      <span className="w-1 shrink-0" />
      <PageTabs pages={pages} activeId={activePageId} onSelect={onSelectPage} onAdd={onAddPage} />
      <span className="min-w-2 flex-1" />
      {/*
       * The right block, flush with the window's right edge in every state: the divider, then
       * the cluster just before the thread toggle, so neither moves between the canvas and the
       * pull request tab or as the rail opens and closes. Open, the block is at least 350 wide,
       * which with the header's 10 of right padding puts the divider on the rail's edge; closed,
       * it is its content's width, the divider just before the cluster. Its width eases between
       * the two on the panes' clock (calc-size, so even from a content width the divider tracks
       * the rail's edge frame by frame instead of stopping where a min-width would let go).
       */}
      <div
        data-chrome-right
        className="pane-motion flex shrink-0 items-center transition-[width]"
        style={{
          width: rail.open
            ? "calc-size(max-content, max(350px, size))"
            : "calc-size(max-content, size)",
        }}
      >
        <ChromeDivider />
        <span className="min-w-[18px] flex-1" />
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
        {right.length ? <span className="w-3 shrink-0" /> : null}
        <ThreadToggle open={rail.open} signal={rail.signal} onToggle={rail.onToggle} />
      </div>
    </>
  );
}
