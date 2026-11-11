import type { CanvasProps } from "@ponzu/canvas";
import { type ReactNode, useCallback, useState } from "react";
import type { DesignMember, DesignSummary, Person, WorkspaceKind } from "../cloud/model.ts";
import { DesignCanvas, DesignChromeSlot, type OpenDesign } from "./design.tsx";
import type { Host } from "./host.ts";
import { BypassConfirmation, PullRequestPane } from "./pull-request-pane.tsx";
import { type CommentLink, DesignRail } from "./thread-rail.tsx";

type CanvasLink = NonNullable<CanvasProps["link"]>;

/*
 * What the window shows for an open design, in AppWindow's three slots: the chrome, the thread
 * rail, and the canvas's pane, which the pull request tab takes over while it is open (the rail
 * folds away meanwhile, and comes back as it was). A board a line of the thread points at is
 * shown on the canvas.
 */

export interface DesignPanes {
  chrome: ReactNode;
  rail: ReactNode | null;
  pane: ReactNode;
}

export function useDesignPanes({
  host,
  me,
  open,
  summary,
  people,
  members,
  workspaceKind,
  sidebarOpen,
  rail,
  page,
  onPage,
  link,
  seenThreadSeq,
  say,
  onClose,
  onConnectClaude,
}: {
  host: Host;
  me: Person;
  open: OpenDesign | null;
  /** Its row in the sidebar, once the list has it. */
  summary: DesignSummary | null;
  /** The workspace's members by id. */
  people: ReadonlyMap<string, Person>;
  members: DesignMember[];
  workspaceKind: WorkspaceKind;
  sidebarOpen: boolean;
  rail: { open: boolean; onToggle: () => void };
  page: string | null;
  onPage: (id: string) => void;
  /** Where a ponzu:// link asked to open it. */
  link: { page?: string; artboard?: string } | null;
  seenThreadSeq: number | null;
  say: (notice: string) => void;
  /** Leave it: back to the create page. */
  onClose: () => void;
  /** Its sign-in ran out (`expired`), or it isn't connected. */
  onConnectClaude?: (expired: boolean) => void;
}): DesignPanes | null {
  // Each is the open design's own: another design opens on its canvas, where its own link or
  // the person left it, never on the last one's tab or board.
  const designId = open?.id ?? null;
  const [tabFor, setTabFor] = useState<string | null>(null);
  const [showing, setShowing] = useState<{ designId: string; link: CanvasLink }>();
  const prTab = designId !== null && tabFor === designId;
  const shown = showing?.designId === designId ? showing.link : null;
  const setPrTab = (open: boolean) => setTabFor(open ? designId : null);

  const onOpenArtboards = useCallback(
    (ids: string[]) => {
      const [artboard] = ids;
      if (!artboard || !designId) return;
      setTabFor(null);
      setShowing({ designId, link: { artboard, at: Date.now() } });
    },
    [designId],
  );
  const onOpenComment = useCallback(
    (to: CommentLink) => {
      if (!designId) return;
      setTabFor(null);
      setShowing({ designId, link: { ...to, at: Date.now() } });
    },
    [designId],
  );

  if (!open) return null;
  const project = summary?.project ?? null;
  const repo = project?.kind === "repo" ? project.repo : null;
  const owner = summary?.owner ?? null;
  const togglePrTab = () => setPrTab(!prTab);
  // The tab folds the rail away; the toggle then says what the rail would, and brings it back.
  const railShown = rail.open && !prTab;
  const toggleRail = () => {
    if (prTab) {
      setPrTab(false);
      if (!rail.open) rail.onToggle();
    } else rail.onToggle();
  };

  return {
    chrome: (
      <DesignChromeSlot
        open={open}
        summary={summary}
        me={me}
        owner={owner}
        workspaceKind={workspaceKind}
        members={members}
        sidebarOpen={sidebarOpen}
        page={page}
        onPage={onPage}
        rail={{ open: railShown, onToggle: toggleRail }}
        prTab={{ open: prTab, onToggle: togglePrTab }}
        seenThreadSeq={seenThreadSeq}
        onOpenRepo={(fullName) => host.openExternal(`https://github.com/${fullName}`)}
      />
    ),
    rail: railShown ? (
      <DesignRail
        host={host}
        open={open}
        me={me}
        people={people}
        repo={repo}
        owner={owner}
        onOpenArtboards={onOpenArtboards}
        onOpenComment={onOpenComment}
        onOpenPullRequest={() => setPrTab(true)}
        say={say}
        {...(onConnectClaude ? { onConnectClaude } : {})}
      />
    ) : null,
    pane: (
      <>
        <div inert={prTab} className="contents">
          <DesignCanvas
            key={open.id}
            host={host}
            open={open}
            me={me}
            page={page}
            onPage={onPage}
            {...(shown ? { link: shown } : link ? { link } : {})}
            onClose={onClose}
          />
        </div>
        {prTab ? (
          // Over the canvas and everything it floats, which stays put underneath for coming back.
          <div className="absolute inset-0 z-20 bg-canvas">
            <PullRequestPane host={host} open={open} viewerLogin={me.login} />
          </div>
        ) : null}
        <BypassConfirmation open={open} />
      </>
    ),
  };
}
