import type { CanvasProps } from "@ponzu/canvas";
import { isTyping } from "@ponzu/canvas/modifier-hint";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasMember, CanvasSummary, Person, WorkspaceKind } from "../cloud/model.ts";
import type { CanvasAddress } from "../cloud/ui/canvas-address.ts";
import { useAnalytics } from "./analytics/provider.tsx";
import { BoardsView, CanvasChromeSlot, type OpenCanvas } from "./canvas.tsx";
import type { Host } from "./host.ts";
import { PullRequestConfirmations, PullRequestPane } from "./pull-request-pane.tsx";
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
  viewerIsAdmin = false,
}: {
  host: Host;
  me: Person;
  /** Whether the viewer is an admin of the canvas's workspace: they may reset its file links. */
  viewerIsAdmin?: boolean;
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
  /**
   * Where a ponzu:// link, a notification or a search result asked to open it: a page, a board,
   * or a comment's thread on the canvas; a line of the thread (`item`), which the rail shows; or
   * the pull request tab. `at` is when: the newer of it and the last jump the thread made is
   * followed, and the same link is followed again.
   */
  link: {
    page?: string;
    artboard?: string;
    thread?: string;
    item?: { id: string; seq: number };
    tab?: "pull-request";
    at?: number;
  } | null;
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
  const jumped = showing?.canvasId === canvasId ? showing.link : null;
  // What of the link is a place on the canvas: none, for a line of the thread or the tab.
  const place = useMemo(
    () => (link && (link.page || link.artboard || link.thread) ? placeOf(link) : null),
    [link],
  );
  // The thread's last jump, or the link the canvas was opened at (search's, on a canvas already
  // open, comes after any jump): whichever was asked for last.
  const shown = jumped && (!place || (jumped.at ?? 0) >= (place.at ?? 0)) ? jumped : null;
  const analytics = useAnalytics();
  const setPrTab = useCallback(
    (open: boolean) => {
      if (canvasId && open !== prTab) {
        analytics.capture("pane toggled", { pane: "pull_request", open, canvas_id: canvasId });
      }
      setTabFor(open ? canvasId : null);
    },
    [canvasId, prTab, analytics],
  );

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

  // A link to the pull request (a notification's or a search result's): the tab opens, as ⌘P
  // opens it. Each link once, when its canvas is the one open: closing it again stays closed.
  const tabAsked = link?.tab === "pull-request" && canvasId ? `${canvasId}:${link.at ?? ""}` : null;
  const tabTaken = useRef<string | null>(null);
  // The last line of the thread a link asked for that the rail has shown: closing the rail and
  // opening it again doesn't go back to it.
  const [revealed, setRevealed] = useState<number | null>(null);
  useEffect(() => {
    if (!tabAsked || !canvasId || tabTaken.current === tabAsked) return;
    tabTaken.current = tabAsked;
    if (tabFor !== canvasId) {
      analytics.capture("pane toggled", { pane: "pull_request", open: true, canvas_id: canvasId });
    }
    setTabFor(canvasId);
  }, [tabAsked, canvasId, tabFor, analytics]);

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

  /*
   * The chrome, the rail and the boards are each drawn again only when their own props change
   * (they are memoized): a live update to the canvas's row in the sidebar, or anything else the
   * window redraws for, hands them the same values and functions as before.
   */
  const prTabProp = useMemo(
    () => ({ open: prTab, onToggle: () => setPrTab(!prTab) }),
    [prTab, setPrTab],
  );
  const openPullRequest = useCallback(() => setPrTab(true), [setPrTab]);
  const openRepo = useCallback(
    (fullName: string) => host.openExternal(`https://github.com/${fullName}`),
    [host],
  );
  const owner = summary?.owner ?? null;
  // Its owner and the workspace's admins, as the API allows.
  const mayReset = owner?.id === me.id || viewerIsAdmin;
  const resetLinks = useMemo(
    () => (mayReset && canvasId ? () => host.api.canvases.rotateAssetKey(canvasId) : null),
    [mayReset, canvasId, host],
  );
  const revealAt = link?.item && (link.at ?? 0) !== revealed ? (link.at ?? 0) : null;
  const revealItem = link?.item;
  const reveal = useMemo(
    () => (revealAt !== null && revealItem ? { ...revealItem, at: revealAt } : null),
    [revealAt, revealItem],
  );
  const boardsLink = shown ?? place;

  if (!open) return null;
  const project = summary?.project ?? null;
  const repo = project?.kind === "repo" ? project.repo : null;

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
        prTab={prTabProp}
        seenThreadSeq={seenThreadSeq}
        onOpenRepo={openRepo}
        resetLinks={resetLinks}
        say={say}
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
        onOpenPullRequest={openPullRequest}
        reveal={reveal}
        onRevealed={setRevealed}
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
            {...(boardsLink ? { link: boardsLink } : {})}
            say={say}
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
        <PullRequestConfirmations open={open} />
      </>
    ),
  };
}

/** A link's place on the canvas, as the canvas follows one: its page, board or comment. */
function placeOf(link: {
  page?: string;
  artboard?: string;
  thread?: string;
  at?: number;
}): BoardsJump {
  return {
    ...(link.page ? { page: link.page } : {}),
    ...(link.artboard ? { artboard: link.artboard } : {}),
    ...(link.thread ? { thread: link.thread } : {}),
    ...(link.at !== undefined ? { at: link.at } : {}),
  };
}
