import type { CanvasProps } from "@ponzu/canvas";
import { isTyping } from "@ponzu/canvas/modifier-hint";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { CanvasMember, CanvasSummary, Person, WorkspaceKind } from "../cloud/model.ts";
import type { CanvasAddress } from "../cloud/ui/canvas-address.ts";
import { useAnalytics } from "./analytics/provider.tsx";
import { BoardsView, CanvasChromeSlot, type OpenCanvas } from "./canvas.tsx";
import type { Host } from "./host.ts";
import { BypassConfirmation, PullRequestPane } from "./pull-request-pane.tsx";
import { CanvasRail, type CommentLink } from "./thread-rail.tsx";

type BoardsJump = NonNullable<CanvasProps["link"]>;

/*
 * What the window shows for an open canvas, in AppWindow's three slots: the chrome, the thread
 * rail, and the main pane, which the pull request tab takes over while it is open. The tab
 * swaps what is in the main pane and nothing else: the rail stays as it was, open or closed,
 * and the canvas waits underneath where it was left. A board a line of the thread points at is
 * shown on the canvas.
 */

export interface CanvasPanes {
  chrome: ReactNode;
  rail: ReactNode | null;
  pane: ReactNode;
  /** What the rail toggle does (⌥⌘B, View › Toggle Thread): from the pull request tab too. */
  toggleRail: () => void;
  /** What the main pane shows: the canvas, or the pull request tab over it. */
  tab: "boards" | "pull-request";
}

export function useCanvasPanes({
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
  onOpenCanvas,
  seenThreadSeq,
  say,
  onClose,
  onConnectClaude,
}: {
  host: Host;
  me: Person;
  open: OpenCanvas | null;
  /** Its row in the sidebar, once the list has it. */
  summary: CanvasSummary | null;
  /** The workspace's members by id. */
  people: ReadonlyMap<string, Person>;
  members: CanvasMember[];
  workspaceKind: WorkspaceKind;
  sidebarOpen: boolean;
  rail: { open: boolean; onToggle: () => void };
  page: string | null;
  onPage: (id: string) => void;
  /** Where a ponzu:// link asked to open it. */
  link: { page?: string; artboard?: string } | null;
  /** Opens another canvas, on a page or board of it, as a ponzu:// link does. */
  onOpenCanvas: (at: CanvasAddress) => void;
  seenThreadSeq: number | null;
  say: (notice: string) => void;
  /** Leave it: back to the create page. */
  onClose: () => void;
  /** Its sign-in ran out (`expired`), or it isn't connected. */
  onConnectClaude?: (expired: boolean) => void;
}): CanvasPanes | null {
  // Each is the open canvas's own: another canvas opens on its boards, where its own link or
  // the person left it, never on the last one's tab or board.
  const canvasId = open?.id ?? null;
  const [tabFor, setTabFor] = useState<string | null>(null);
  const [showing, setShowing] = useState<{ canvasId: string; link: BoardsJump }>();
  const prTab = canvasId !== null && tabFor === canvasId;
  const shown = showing?.canvasId === canvasId ? showing.link : null;
  const analytics = useAnalytics();
  const setPrTab = (open: boolean) => {
    if (canvasId && open !== prTab) {
      analytics.capture("pane toggled", { pane: "pull_request", open, canvas_id: canvasId });
    }
    setTabFor(open ? canvasId : null);
  };

  // The tab is read-only: ⌘Z there has nothing to undo. Uncaught, it would reach Edit › Undo,
  // which reverts the last typing anywhere in the window (the thread's draft, beside the tab) and
  // jumps there. On a page the canvas takes it; on the tab it is taken here, unless in a field.
  useEffect(() => {
    if (!prTab) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !isTyping(e)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prTab]);

  // Every jump the thread makes (a comment, a stretch of work, a link in a reply) is the canvas
  // following a link, as a ponzu:// one does: the same framing and the same mark.
  const show = useCallback(
    (to: Omit<BoardsJump, "at">) => {
      if (!canvasId) return;
      setTabFor(null);
      setShowing({ canvasId, link: { ...to, at: Date.now() } });
    },
    [canvasId],
  );
  const onOpenArtboards = useCallback(
    (ids: string[]) => {
      const [artboard] = ids;
      if (artboard) show({ artboard });
    },
    [show],
  );
  const onOpenComment = useCallback((to: CommentLink) => show(to), [show]);
  // A link to a page or board: on this canvas's boards, or another canvas opened there.
  const onOpenPlace = useCallback(
    (at: CanvasAddress) => {
      if (at.canvasId !== canvasId) onOpenCanvas(at);
      else if (at.artboard) show({ artboard: at.artboard });
      else if (at.page) show({ page: at.page });
      // The canvas itself, as older replies link it: show the page that's open, whole.
      else if (page) show({ page });
      else setTabFor(null);
    },
    [canvasId, page, show, onOpenCanvas],
  );

  if (!open) return null;
  const project = summary?.project ?? null;
  const repo = project?.kind === "repo" ? project.repo : null;
  const owner = summary?.owner ?? null;
  const togglePrTab = () => setPrTab(!prTab);

  return {
    toggleRail: rail.onToggle,
    tab: prTab ? "pull-request" : "boards",
    chrome: (
      <CanvasChromeSlot
        // Made anew for each canvas: what it has at once is simply there, never an entrance.
        key={open.id}
        open={open}
        summary={summary}
        me={me}
        owner={owner}
        workspaceKind={workspaceKind}
        members={members}
        sidebarOpen={sidebarOpen}
        page={page}
        onPage={onPage}
        rail={rail}
        prTab={{ open: prTab, onToggle: togglePrTab }}
        seenThreadSeq={seenThreadSeq}
        onOpenRepo={(fullName) => host.openExternal(`https://github.com/${fullName}`)}
      />
    ),
    rail: rail.open ? (
      <CanvasRail
        host={host}
        open={open}
        me={me}
        people={people}
        repo={repo}
        owner={owner}
        onOpenArtboards={onOpenArtboards}
        onOpenComment={onOpenComment}
        onOpenPlace={onOpenPlace}
        onOpenPullRequest={() => setPrTab(true)}
        say={say}
        {...(onConnectClaude ? { onConnectClaude } : {})}
      />
    ) : null,
    pane: (
      <>
        <div inert={prTab} className="contents">
          <BoardsView
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
          // A repo's code and file names: masked in a private recording (analytics/privacy.ts).
          <div data-replay="mask" className="absolute inset-0 z-20 bg-canvas">
            <PullRequestPane host={host} open={open} viewerLogin={me.login} />
          </div>
        ) : null}
        <BypassConfirmation open={open} />
      </>
    ),
  };
}
