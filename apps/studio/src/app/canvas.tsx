import { Canvas, type CanvasProps } from "@ponzu/canvas";
import { type CanvasHeadRow, DocCache, type LiveRows, presentNow } from "@ponzu/client";
import { CloudSource, type Unsaved } from "@ponzu/client/canvas";
import { useLiveQuery } from "@ponzu/client/react";
import { type Actor, type Doc, newId } from "@ponzu/core";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ResetFileLinksDialog } from "../cloud/dialogs/reset-file-links.tsx";
import type {
  Attachment,
  CanvasMember,
  CanvasSummary,
  Person,
  WorkspaceKind,
} from "../cloud/model.ts";
import { actionBlock, nextAction } from "../cloud/pull-request.ts";
import { railSignal } from "../cloud/status.ts";
import { useNow } from "../cloud/time.ts";
import { useColorScheme } from "../cloud/ui/color-scheme.ts";
import { CanvasChrome } from "../cloud/window/canvas-chrome.tsx";
import { useAnalytics } from "./analytics/provider.tsx";
import { AskStore } from "./ask-store.ts";
import { drawCommentPicture, hasPictureArea } from "./comment-picture.tsx";
import { CommentPictures } from "./comment-pictures.ts";
import type { Host } from "./host.ts";
import { contributors, pageTabs } from "./map.ts";
import { Banner, PaneMessage } from "./notices.tsx";
import { useWindowFocused } from "./notifications.ts";
import { usePonzu } from "./ponzu-query.tsx";
import { chromeAction, offeredTab, prSummary, rowPullRequest } from "./pull-request-map.ts";
import { PullRequestStore } from "./pull-request-store.ts";
import { branchMoment, steerGate } from "./thread-map.ts";
import { ThreadStore } from "./thread-store.ts";
import { Uploads } from "./uploads.ts";
import { useOnReturn } from "./use-answer.ts";
import { useHandlers, useKeptElement } from "./use-kept.ts";
import { useSnapshot } from "./use-snapshot.ts";

/*
 * An open canvas: the boards view on a `CloudSource`, and the chrome over it, both driven by the
 * same source and the canvas's live head; its thread, what its agent waits on, the images on
 * their way into a message, the pictures of the viewer's comments, and its pull request. All of
 * them live as long as the canvas is open.
 */

export interface OpenCanvas {
  id: string;
  source: CloudSource;
  thread: ThreadStore;
  asks: AskStore;
  uploads: Uploads;
  pictures: CommentPictures;
  pullRequest: PullRequestStore;
  /** What the create page knew of a canvas it just made, until the API's own reads arrive. */
  fresh: FreshCanvas | null;
}

/**
 * A canvas the create page has just made, as its answer said: it opens straight into its
 * thread with its first message and the agent waking, rather than empty while its boards, the
 * thread and the head are read.
 */
export interface FreshCanvas {
  id: string;
  name: string;
  /** Its first message, which the API already has; none when it is still to be sent. */
  message: string | null;
  /** The images it went with, as the create page showed them, until the thread has its own. */
  attachments?: Attachment[];
  access: "read" | "write";
  head: Pick<CanvasHeadRow, "agentState" | "agentStatus" | "agentBlocker">;
}

/**
 * The open canvas, made when `canvasId` changes and closed when it does again. `say` puts a
 * sentence over the window: why an answer or an action on the pull request didn't go.
 */
export function useOpenCanvas(
  host: Host,
  me: Person,
  canvasId: string | null,
  say: (notice: string) => void,
  fresh: FreshCanvas | null = null,
): OpenCanvas | null {
  const [open, setOpen] = useState<OpenCanvas | null>(null);
  const { queryClient, queries, mutations } = usePonzu();
  const ponzu = useMemo(
    () => ({ queryClient, queries, mutations }),
    [queryClient, queries, mutations],
  );
  const actor = useMemo<Actor>(
    () => ({
      kind: "user",
      id: me.id,
      name: me.name,
      ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
    }),
    [me],
  );
  const cache = useMemo(
    () => (host.docStorage ? new DocCache(host.docStorage, 4) : undefined),
    [host],
  );
  const saying = useRef(say);
  saying.current = say;
  const made = useRef(fresh);
  made.current = fresh;
  // Whether the person is looking at it: the window in front with this canvas open. Presence
  // says so from the first beat, and at once when it changes, so nobody is pinged about the
  // canvas in front of them, and opening it reads its notifications (docs/cloud.md, "Notifications").
  const focused = useWindowFocused();
  const focusedNow = useRef(focused);
  focusedNow.current = focused;
  // Before the window paints: the create page gives way to the canvas in the same frame.
  useLayoutEffect(() => {
    if (!canvasId) {
      setOpen(null);
      return;
    }
    const known = made.current?.id === canvasId ? made.current : null;
    const { canvas, close } = openCanvas({
      host,
      ponzu,
      actor,
      cache,
      canvasId,
      focused: focusedNow.current,
      known,
      saying,
    });
    setOpen(canvas);
    return close;
  }, [host, ponzu, actor, cache, canvasId]);
  // The source alone, not `open`: a closure here that read `open` would put it in this render's
  // scope, which the closures of the canvas opened next would then keep (see `openCanvas`).
  const openSource = open?.source;
  useEffect(() => {
    openSource?.setFocused(focused);
  }, [openSource, focused]);
  return open && open.id === canvasId ? open : null;
}

/**
 * Makes an open canvas's source and stores, and what closes them. It lives outside the hook on
 * purpose: V8 gives every closure made in one function a single shared scope, chained to the scope
 * of the render around it. Closures the stores keep (an ask's error, the pull request's sentence
 * and its word to the agent) made inside the hook's effect would keep that render, and with it
 * the canvas open before, whose stores keep the render before that: every canvas opened in the
 * window, with its whole document, for as long as the window lives. Made here, they keep only
 * what they are given.
 */
function openCanvas({
  host,
  ponzu,
  actor,
  cache,
  canvasId,
  focused,
  known,
  saying,
}: {
  host: Host;
  ponzu: ConstructorParameters<typeof ThreadStore>[0]["ponzu"];
  actor: Actor;
  cache: DocCache | undefined;
  canvasId: string;
  focused: boolean;
  known: FreshCanvas | null;
  saying: { readonly current: (notice: string) => void };
}): { canvas: OpenCanvas; close: () => void } {
  const { api, live } = host;
  const source = new CloudSource({
    api,
    live,
    canvasId,
    me: actor,
    focused,
    ...(cache ? { cache } : {}),
  });
  const thread = new ThreadStore({ ponzu, live, canvasId, meId: actor.id }).start();
  if (known?.message) thread.seed(known.message, known.attachments);
  const asks = new AskStore({ ponzu, live, canvasId, onError: (m) => saying.current(m) });
  asks.start();
  const uploads = new Uploads({ ponzu, canvasId });
  const pictures = new CommentPictures({
    canvasId,
    meId: actor.id,
    source,
    api: api.canvases,
    draw: drawCommentPicture,
    drawable: hasPictureArea,
  }).start();
  const pullRequest = new PullRequestStore({
    ponzu,
    canvasId,
    say: (m) => saying.current(m),
    tellAgent: (text) => thread.send(text, []),
  });
  return {
    canvas: { id: canvasId, source, thread, asks, uploads, pictures, pullRequest, fresh: known },
    close: () => {
      source.close();
      thread.close();
      asks.close();
      uploads.close();
      pictures.close();
      pullRequest.close();
    },
  };
}

/**
 * One thing read from the source's state, drawn again only when it changes. `select` returns a
 * primitive, or the same object for the same state, so an op that leaves it as it was (a comment,
 * for what reads the pages) draws nothing.
 */
export function useSourceSelect<T>(
  source: CloudSource,
  select: (state: ReturnType<CloudSource["getState"]>) => T,
): T {
  // The same subscribe function while the source is the same, so React doesn't let go of the
  // source and subscribe again on every render.
  const subscribe = useCallback((changed: () => void) => source.subscribe(changed), [source]);
  return useSyncExternalStore(subscribe, () => select(source.getState()));
}

const shapes = new WeakMap<object, string>();

/**
 * The document's pages as the window around the boards reads them, as one string: each page's
 * id, name and icon, and its boards' ids and names. The same while ops change only what is on
 * the boards or in the comments; null until there is a document.
 */
export function docShape(doc: Doc | null): string | null {
  if (!doc) return null;
  let shape = shapes.get(doc.pages);
  if (shape === undefined) {
    shape = JSON.stringify(
      doc.pages.map((page) => [
        page.id,
        page.name,
        page.icon ?? null,
        page.artboards.map((board) => [board.id, board.name ?? null]),
      ]),
    );
    shapes.set(doc.pages, shape);
  }
  return shape;
}

/**
 * What the viewer may do with the open canvas, once the API has said: look, or also steer.
 * Null until then, so nothing offers to steer that can't, or hides what can.
 */
export function useAccess(open: OpenCanvas): "read" | "write" | null {
  const said = useSourceSelect(open.source, (state) =>
    state.status === "ready" ? (open.source.writable ? "write" : "read") : null,
  );
  // The API's word arrives with the replica, and holds while the network comes and goes; a copy
  // shown offline before it doesn't carry it.
  const known = useRef<{ id: string; access: "read" | "write" } | null>(null);
  if (said) {
    known.current = { id: open.id, access: said };
  }
  return known.current?.id === open.id ? known.current.access : (open.fresh?.access ?? null);
}

/**
 * The chrome past the left block for an open canvas. Drawn again when what it shows changes, not
 * with every op: the pages it reads are the document's shape (docShape), and the window around it
 * hands it the same props until they change.
 */
export const CanvasChromeSlot = memo(function CanvasChromeSlot({
  open,
  summary,
  me,
  owner,
  workspaceKind,
  members,
  sidebarOpen,
  page,
  onPage,
  rail,
  prTab,
  seenThreadSeq,
  onOpenRepo,
  resetLinks = null,
  say,
}: {
  open: OpenCanvas;
  /** Its sidebar row, once the list has it. */
  summary: CanvasSummary | null;
  me: Person;
  /** Its owner among the workspace's members. */
  owner: Person | null;
  workspaceKind: WorkspaceKind;
  members: CanvasMember[];
  sidebarOpen: boolean;
  page: string | null;
  onPage: (id: string) => void;
  rail: { open: boolean; onToggle: () => void };
  /** The pull request tab, open in the main pane in place of the page. */
  prTab: { open: boolean; onToggle: () => void };
  /** How far the viewer has read the thread, for the rail toggle's dot. */
  seenThreadSeq: number | null;
  onOpenRepo: (fullName: string) => void;
  /**
   * Resets the canvas's file links, for Share's foot: only for its owner and the workspace's
   * admins, who are the only ones the API lets; null for everyone else, and the foot is not shown.
   */
  resetLinks?: (() => Promise<unknown>) | null;
  /** A sentence over the window: whether the reset went. */
  say: (notice: string) => void;
}) {
  const shape = useSourceSelect(open.source, (state) => docShape(state.doc));
  const docName = useSourceSelect(open.source, (state) => state.doc?.name ?? null);
  // Share's "Reset file links" asks first; busy while the API copies the files across.
  const [resetting, setResetting] = useState<"asking" | "busy" | null>(null);
  const confirmReset = () => {
    if (!resetLinks || resetting === "busy") return;
    setResetting("busy");
    resetLinks().then(
      () => {
        setResetting(null);
        say("This canvas's file links are reset.");
      },
      () => {
        setResetting(null);
        say("The file links couldn't be reset. Try again.");
      },
    );
  };
  const head = useLiveQuery("canvas.head", { canvasId: open.id }).rows?.[0];
  const presence = useLiveQuery("canvas.presence", { canvasId: open.id }).rows ?? [];
  const meRow = useLiveQuery("me", {}).rows?.[0];
  const thread = useSnapshot(open.thread);
  const pull = useSnapshot(open.pullRequest);
  const access = useAccess(open);
  const now = useNow();
  const agentArtboards = head?.agentArtboards;
  // Made again when the pages change (`shape` says so), not each time the boards do.
  const pages = useMemo(() => {
    const doc = open.source.getState().doc;
    return doc ? pageTabs(doc.pages, agentArtboards ?? []) : [];
  }, [open.source, shape, agentArtboards]);
  const project = summary?.project ?? null;
  const repo = project?.kind === "repo" ? project.repo : null;
  usePullRequestReads(open, repo !== null, head, thread.items);

  // The mark from the canvas's head, live; until the head has come, from what the sidebar's row
  // already says (the same columns), with what the last read of GitHub said of whether it can
  // merge. So a canvas opens with its mark at once, and the head confirms it without a change.
  const pr = head ? prSummary(head) : rowPullRequest(summary, pull.tab);
  // The last answer kept from an earlier opening is offered only while it agrees with what the
  // row and the head say now: a pull request merged, closed or pushed to since doesn't offer
  // what it did (Merge on one already merged) before the read on opening says.
  const tab = offeredTab(pull, pr);
  const kind = repo && tab ? chromeAction(tab) : null;
  // Until its own answer, the action its row's pull request most likely offers: its room is
  // held, unseen, so the mark beside it doesn't move when it comes. Not for one that is merged
  // or closed, or with no pull request, which as often offer nothing.
  const expected =
    repo && !tab && pr && (pr.state === "open" || pr.state === "draft")
      ? nextAction(pr, false)
      : null;
  const gate = steerGate({ access, repo, head, owner, me: meRow, now });
  const worked = useMemo(
    () =>
      threadPeople(thread.items ?? []).flatMap(({ id, at }) => {
        const person = members.find((m) => m.person.id === id)?.person;
        return person ? [{ person, at }] : [];
      }),
    [thread.items, members],
  );
  const unseen =
    !rail.open && (thread.items ?? []).some((i) => i.seq > (seenThreadSeq ?? 0) && !saidBy(i, me));
  const signal = railSignal(
    {
      needsYou: head?.needsYouCount ?? summary?.needsYou ?? 0,
      agentState: head?.agentState ?? summary?.agentState ?? "idle",
    },
    unseen,
  );
  // What the chrome's controls do: the same functions every time, so the chrome below is drawn
  // again only when what it shows changes (`useKeptElement`), not with every update to the
  // canvas's row, its thread or its head.
  const does = useHandlers({
    selectPage: (id: string) => {
      if (prTab.open) prTab.onToggle();
      onPage(id);
    },
    addPage: () => {
      const doc = open.source.getState().doc;
      if (!doc) return;
      const id = newId("pg");
      open.source.apply({
        op: "page.create",
        index: doc.pages.length,
        page: { id, name: `Page ${doc.pages.length + 1}` },
      });
      onPage(id);
    },
    openRepo: () => {
      if (project?.kind === "repo") onOpenRepo(`${project.repo.owner}/${project.repo.name}`);
    },
    askReset: () => setResetting("asking"),
    toggleTab: () => prTab.onToggle(),
    toggleRail: () => rail.onToggle(),
    run: (action: Parameters<OpenCanvas["pullRequest"]["run"]>[0]) => open.pullRequest.run(action),
  });
  const chrome = useKeptElement(CanvasChrome, {
    name: head?.name ?? summary?.name ?? docName ?? open.fresh?.name ?? "",
    sidebarOpen,
    pages,
    activePageId: prTab.open ? null : (page ?? pages[0]?.id ?? null),
    onSelectPage: does.selectPage,
    onAddPage: shape !== null && access === "write" ? does.addPage : null,
    team:
      workspaceKind === "org" && project?.kind === "repo"
        ? {
            meId: me.id,
            contributors: contributors(presentNow(presence, now), me, worked),
            repo: project.repo,
            members,
            onOpenRepo: does.openRepo,
            onResetLinks: resetLinks ? does.askReset : null,
          }
        : null,
    pullRequest: repo && pr ? { pr, tabOpen: prTab.open, onToggleTab: does.toggleTab } : null,
    action: kind
      ? {
          kind,
          busy: pull.busy !== null,
          blocked: actionBlock(kind, gate, me.id) ?? (pull.asked === kind ? ASKED : null),
          onRun: does.run,
        }
      : null,
    rail: { open: rail.open, signal, onToggle: does.toggleRail },
    actionExpected: expected,
  });
  return (
    <>
      {chrome}
      <ResetFileLinksDialog
        open={resetting !== null}
        busy={resetting === "busy"}
        onCancel={() => setResetting(null)}
        onConfirm={confirmReset}
      />
    </>
  );
});

/**
 * Reads the pull request as the canvas opens (at once, not waiting for its head), and again
 * when what the head says of it changes, when the agent's state changes or a stretch of its
 * work ends (it may have pushed), when the thread says a pull request opened, merged or closed,
 * and on coming back to the window. A Scratch canvas (no `repo`) has none to read.
 */
function usePullRequestReads(
  open: OpenCanvas,
  repo: boolean,
  head: CanvasHeadRow | undefined,
  items: readonly RunnerItem[] | null,
) {
  useEffect(() => {
    if (repo) open.pullRequest.refreshOnOpen();
  }, [open, repo]);
  const branch = items ? branchMoment(items) : 0;
  const key =
    repo && head
      ? [
          head.prNumber,
          head.prState,
          head.prChecks,
          head.prMergeable,
          head.prAutoMerge,
          head.agentState,
          branch,
        ].join()
      : null;
  // The head as it first comes is what the read on opening already asked about.
  const first = useRef<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    if (first.current === null) {
      first.current = key;
      return;
    }
    // A burst of changes (a push and its checks starting) is one read.
    const timer = setTimeout(() => open.pullRequest.refresh(), READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [open, key]);
  useOnReturn(() => {
    if (key !== null) open.pullRequest.refresh();
  }, RETURN_READ_MS);
  // What was asked of the agent may be asked again once its turn is over.
  const idle = head?.agentState === "idle";
  useEffect(() => {
    if (idle) open.pullRequest.agentIdle();
  }, [open, idle]);
}

const READ_AFTER_MS = 300;
const RETURN_READ_MS = 30_000;
/** The next action's tip once the agent has been asked to do it for this commit. */
const ASKED = "Asked Claude";

type RunnerItem = LiveRows["canvas.thread"];

/** Whether the viewer said it: what they said is never news to them. */
function saidBy(item: RunnerItem, me: Person): boolean {
  return (item.kind === "message" || item.kind === "comment") && item.payload.from.id === me.id;
}

/** The people who have said something in the thread, each with the last time they did. */
function threadPeople(items: readonly RunnerItem[]): { id: string; at: string }[] {
  const last = new Map<string, string>();
  for (const item of items) {
    if (item.kind === "message" || item.kind === "comment") last.set(item.payload.from.id, item.at);
  }
  return [...last].map(([id, at]) => ({ id, at }));
}

/**
 * The main pane for an open canvas, with what can go wrong said over it. The boards themselves
 * follow the source on their own (Canvas): this is drawn again only when whether there is a
 * document, or how the source stands, changes.
 */
export const BoardsView = memo(function BoardsView({
  host,
  open,
  me,
  page,
  onPage,
  link,
  say,
  onClose,
}: {
  host: Host;
  open: OpenCanvas;
  me: Person;
  page: string | null;
  onPage: (id: string) => void;
  /** Where a link, or a line of the thread, asked to show it. */
  link?: CanvasProps["link"];
  /** Says over the window that a comment a link named has been deleted since. */
  say?: (notice: string) => void;
  /** Leave it: back to the create page. */
  onClose: () => void;
}) {
  const { source, id } = open;
  const status = useSourceSelect(source, (state) => state.status);
  const held = useSourceSelect(source, (state) => state.doc !== null);
  const theme = useColorScheme();
  const head = useLiveQuery("canvas.head", { canvasId: id });
  const seq = head.rows?.[0]?.seq;
  // A canvas you can open always has its head row: none, live, is one deleted or taken away.
  const gone = status === "error" || (head.status === "live" && head.rows?.length === 0);
  const unsaved = useUnsaved(source);
  const analytics = useAnalytics();

  // The person has seen it as it stands: the sidebar's dot goes.
  useEffect(() => {
    if (seq === undefined || status !== "ready") return;
    const timer = setTimeout(() => void host.api.canvases.seen(id).catch(() => {}), 1000);
    return () => clearTimeout(timer);
  }, [host, id, seq, status]);

  // The page each tab shows is the chrome's; the others hear it through presence.
  useEffect(() => {
    source.setPage(page);
  }, [source, page]);

  // A comment the link names that is gone (a search's answer can be older than the canvas): the
  // canvas shows where it was, and this says why there is no thread. Each link is judged once,
  // when the document first holds it: a comment deleted later, while the canvas is open (by the
  // person themself, say), isn't news to announce.
  const linkThread = link?.thread;
  const linkKey = linkThread ? `${linkThread}:${link?.at ?? ""}` : null;
  const judged = useRef<string | null>(null);
  useEffect(() => {
    const doc = source.getState().doc;
    if (!linkThread || !linkKey || !doc || judged.current === linkKey) return;
    judged.current = linkKey;
    if (!doc.threads.some((t) => t.id === linkThread)) {
      say?.("That comment was deleted. This is where it was.");
    }
  }, [source, linkThread, linkKey, held, say]);

  // The network is back: don't wait out the retry.
  useEffect(() => {
    const online = () => source.retryNow();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [source]);

  // The boards follow the source themselves: the head moving on with every op (`seq`, read
  // above) hands them the same element, so they aren't drawn again for it.
  const readOnly = !source.writable;
  const boards = useMemo(
    () => (
      <Canvas
        source={source}
        me={{
          kind: "user",
          id: me.id,
          name: me.name,
          ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
        }}
        theme={theme}
        readOnly={readOnly}
        pageBar={false}
        {...(page ? { page } : {})}
        onPageChange={onPage}
        {...(link ? { link } : {})}
        onModeChange={(mode) => {
          if (mode === "comment") analytics.capture("comment mode entered", { canvas_id: id });
        }}
      />
    ),
    [source, me, theme, readOnly, page, onPage, link, analytics, id],
  );

  if (gone) {
    return (
      <PaneMessage
        title="This canvas isn't here any more"
        body="It was deleted, or you no longer have access to its repo on GitHub."
        action={{ label: "Back to canvases", onClick: onClose }}
      />
    );
  }
  if (!held) {
    return status === "offline" ? (
      <PaneMessage
        title="Can't reach Ponzu"
        body="This canvas opens as soon as you're back online."
        busy
      />
    ) : open.fresh ? (
      // Just made on the create page: its dotted ground stays until the canvas draws its own.
      <div className="canvas-dots absolute inset-0" />
    ) : null;
  }
  return (
    <>
      {boards}
      {status === "offline" ? (
        <Banner>You're offline. Your changes are kept here and sent when you're back.</Banner>
      ) : unsaved ? (
        <Banner>{unsaved.reason}</Banner>
      ) : null}
    </>
  );
});

/** The last edit that didn't make it, shown for a few seconds. */
function useUnsaved(source: CloudSource): Unsaved | null {
  const [unsaved, setUnsaved] = useState<Unsaved | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () =>
      source.onUnsaved((next) => {
        setUnsaved(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setUnsaved(null), 6000);
      }),
    [source],
  );
  return unsaved;
}
