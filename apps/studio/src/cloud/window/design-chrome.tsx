import type { Contributor, DesignMember, PageTab, PullRequestSummary, Repo } from "../model.ts";
import type { NextAction } from "../pull-request.ts";
import type { RailSignal } from "../status.ts";
import { cn } from "../ui/cn.ts";
import { Popover, PopoverAnchor } from "../ui/popover.tsx";
import { Arrival } from "./arrival.tsx";
import { ChromeDivider } from "./chrome.tsx";
import { ActionRoom, NextActionButton } from "./next-action.tsx";
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
  /**
   * The action the design is expected to offer while its own answer is on its way (from what
   * the sidebar's row says of its pull request): its room is held, unseen, from the first frame.
   */
  actionExpected?: NextAction | null;
}

/**
 * The chrome past the left block while a design is open: its name while the sidebar is
 * collapsed, the divider, its pages; then who is in it, its pull request and next action, the
 * rail's divider, and the thread toggle last at the window's right edge. The spacing between the
 * right-hand pieces is the design's, whichever of them a design has.
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
  actionExpected = null,
}: DesignChromeProps) {
  // The cluster's pieces, each with the 10 before it, so a piece that comes or goes takes its
  // gap with it (the cluster starts 10 early to make up the first's); then 12 before the
  // divider. The cluster's box ends where its last piece does, for Share to align to. Each may
  // come after the first paint (its answer late), and then arrives as one movement (arrival.tsx): its room
  // opens on the panes' clock, what is beside it glides aside, and it fades in where it rests.
  // The action's room is held unseen while it is expected (`actionExpected`), so when it comes
  // nothing moves unless its words differ from what was expected.
  const gap = <span className="w-2.5 shrink-0" />;
  const cluster = (
    <div className="-ml-2.5 flex shrink-0 items-center">
      <Arrival show={team !== null} name="presence">
        {gap}
        {team ? <Presence contributors={team.contributors} meId={team.meId} /> : null}
      </Arrival>
      <Arrival show={pullRequest !== null} name="pull-request">
        {gap}
        {pullRequest ? (
          <PullRequestTab
            pr={pullRequest.pr}
            active={pullRequest.tabOpen}
            onToggle={pullRequest.onToggleTab}
          />
        ) : null}
      </Arrival>
      <Arrival
        show={action !== null}
        name="action"
        placeholder={
          actionExpected ? (
            <>
              {gap}
              <ActionRoom action={actionExpected} />
            </>
          ) : null
        }
      >
        {gap}
        {action ? (
          <NextActionButton
            action={action.kind}
            busy={action.busy}
            blocked={action.blocked}
            onRun={action.onRun}
          />
        ) : null}
      </Arrival>
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
          // A design's name: masked in a private session replay, as its row is (analytics/privacy.ts).
          data-replay="mask"
          className={cn(
            // Hidden once its room has closed (visibility waits out the transition). The name is
            // set once against its own 240 and the room only clips it, under a fade at its right
            // edge (on the name's 12 of padding at rest), so no letter is cut against the
            // divider; closing, it fades out on the hover clock, before the room is half shut.
            "pane-motion flex overflow-hidden transition-[width,opacity,visibility] [mask-image:linear-gradient(to_right,black_calc(100%-12px),transparent)]",
            sidebarOpen
              ? "invisible w-0 opacity-0 [transition-duration:var(--dur-pane),var(--dur-hover),var(--dur-pane)]"
              : "w-auto",
          )}
        >
          {/* No padding before it: the header's own gap and the toggle's inset already put the
              name as far from the toggle's icon as the icon is from the traffic lights (14). */}
          <Arrival show={name !== ""} anchor="start" name="title">
            <span className="max-w-[240px] shrink-0 truncate pr-3 font-medium text-13 text-ink">
              {name}
            </span>
          </Arrival>
        </span>
        <ChromeDivider pane="sidebar" />
      </span>
      <span className="w-1 shrink-0" />
      {/* The pages come with the design's document: they fade in where they rest, and nothing
          beside them moves (the space after them takes up the difference). */}
      <Arrival show={pages.length > 0} room={false} anchor="start" name="pages">
        <PageTabs pages={pages} activeId={activePageId} onSelect={onSelectPage} onAdd={onAddPage} />
      </Arrival>
      <span className="min-w-2 flex-1" />
      {/*
       * The right side, the left's mirror: `[people] [pull request] [action] | … [toggle]`. The
       * cluster ends 12 before the divider, and the divider starts the rail's block, which ends
       * with the thread toggle 10 from the window's edge. Open, the block is the rail's width
       * (`--pane-rail`, the rail's own), so the divider's pixel is the canvas's last column, as
       * the left divider's is its first, and the cluster sits over the canvas; closed, the block
       * is only the divider, 12 and the toggle, together at the window's edge.
       *
       * Between the two it eases on the panes' clock by its min-width: from 1px closed to the
       * rail's width open, less 5 (it reaches 4 into the header's 10 of padding, and the
       * divider's pixel is the canvas's). The canvas's edge moves from 6 to the rail's width
       * from the window's edge on the same curve (the rail opening as the canvas's 6 of margin
       * closes), so the divider keeps to it to the pixel until only the toggle's room is left,
       * and holds there. The cluster rides with the divider; the page tabs give way to it.
       */}
      <div className="flex shrink-0 items-center">
        {/* Share's popover is anchored on the cluster, there or not, so nothing in the cluster
            is made again when the people arrive. */}
        <Popover>
          <PopoverAnchor asChild>{cluster}</PopoverAnchor>
          {team ? (
            <SharePopover
              designName={name}
              repo={team.repo}
              members={team.members}
              meId={team.meId}
              onOpenRepo={team.onOpenRepo}
            />
          ) : null}
        </Popover>
        <span className="w-3 shrink-0" />
        <div
          data-chrome-rail
          className={cn(
            "pane-motion -mr-1 flex shrink-0 items-center transition-[min-width]",
            rail.open ? "min-w-[calc(var(--pane-rail,360px)-5px)]" : "min-w-px",
          )}
        >
          <ChromeDivider pane="rail" />
          <span className="min-w-3 flex-1" />
          <ThreadToggle open={rail.open} signal={rail.signal} onToggle={rail.onToggle} />
          <span className="w-1 shrink-0" />
        </div>
      </div>
    </>
  );
}
