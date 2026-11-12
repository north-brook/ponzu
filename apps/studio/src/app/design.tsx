import { Canvas, type CanvasProps } from "@ponzu/canvas";
import { type DesignHeadRow, DocCache, type LiveRows, presentNow } from "@ponzu/client";
import { CloudSource, type Unsaved } from "@ponzu/client/canvas";
import { useLiveQuery } from "@ponzu/client/react";
import { type Actor, newId } from "@ponzu/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  Attachment,
  DesignMember,
  DesignSummary,
  Person,
  WorkspaceKind,
} from "../cloud/model.ts";
import { actionBlock, nextAction } from "../cloud/pull-request.ts";
import { railSignal } from "../cloud/status.ts";
import { useNow } from "../cloud/time.ts";
import { useColorScheme } from "../cloud/ui/color-scheme.ts";
import { DesignChrome } from "../cloud/window/design-chrome.tsx";
import { useAnalytics } from "./analytics/provider.tsx";
import { AskStore } from "./ask-store.ts";
import { drawCommentPicture, hasPictureArea } from "./comment-picture.tsx";
import { CommentPictures } from "./comment-pictures.ts";
import type { Host } from "./host.ts";
import { contributors, pageTabs } from "./map.ts";
import { Banner, PaneMessage } from "./notices.tsx";
import { usePonzu } from "./ponzu-query.tsx";
import { chromeAction, offeredTab, prSummary, rowPullRequest } from "./pull-request-map.ts";
import { PullRequestStore } from "./pull-request-store.ts";
import { branchMoment, steerGate } from "./thread-map.ts";
import { ThreadStore } from "./thread-store.ts";
import { Uploads } from "./uploads.ts";
import { useOnReturn } from "./use-answer.ts";
import { useSnapshot } from "./use-snapshot.ts";

/*
 * An open design: the canvas on a `CloudSource`, and the chrome over it, both driven by the
 * same source and the design's live head; its thread, what its agent waits on, the images on
 * their way into a message, the pictures of the viewer's comments, and its pull request. All of
 * them live as long as the design is open.
 */

export interface OpenDesign {
  id: string;
  source: CloudSource;
  thread: ThreadStore;
  asks: AskStore;
  uploads: Uploads;
  pictures: CommentPictures;
  pullRequest: PullRequestStore;
  /** What the create page knew of a design it just made, until the API's own reads arrive. */
  fresh: FreshDesign | null;
}

/**
 * A design the create page has just made, as its answer said: it opens straight into its
 * thread with its first message and the agent waking, rather than empty while the canvas, the
 * thread and the head are read.
 */
export interface FreshDesign {
  id: string;
  name: string;
  /** Its first message, which the API already has; none when it is still to be sent. */
  message: string | null;
  /** The images it went with, as the create page showed them, until the thread has its own. */
  attachments?: Attachment[];
  access: "read" | "write";
  head: Pick<DesignHeadRow, "agentState" | "agentStatus" | "agentBlocker">;
}

/**
 * The open design, made when `designId` changes and closed when it does again. `say` puts a
 * sentence over the window: why an answer or an action on the pull request didn't go.
 */
export function useOpenDesign(
  host: Host,
  me: Person,
  designId: string | null,
  say: (notice: string) => void,
  fresh: FreshDesign | null = null,
): OpenDesign | null {
  const [open, setOpen] = useState<OpenDesign | null>(null);
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
  // Before the window paints: the create page gives way to the design in the same frame.
  useLayoutEffect(() => {
    if (!designId) {
      setOpen(null);
      return;
    }
    const { api, live } = host;
    const source = new CloudSource({
      api,
      live,
      designId,
      me: actor,
      ...(cache ? { cache } : {}),
    });
    const thread = new ThreadStore({ ponzu, live, designId, meId: actor.id }).start();
    const known = made.current?.id === designId ? made.current : null;
    if (known?.message) thread.seed(known.message, known.attachments);
    const asks = new AskStore({ ponzu, live, designId, onError: (m) => saying.current(m) });
    asks.start();
    const uploads = new Uploads({ ponzu, designId });
    const pictures = new CommentPictures({
      designId,
      meId: actor.id,
      source,
      api: api.designs,
      draw: drawCommentPicture,
      drawable: hasPictureArea,
    }).start();
    const pullRequest = new PullRequestStore({
      ponzu,
      designId,
      say: (m) => saying.current(m),
      tellAgent: (text) => thread.send(text, []),
    });
    setOpen({ id: designId, source, thread, asks, uploads, pictures, pullRequest, fresh: known });
    return () => {
      source.close();
      thread.close();
      asks.close();
      uploads.close();
      pictures.close();
      pullRequest.close();
    };
  }, [host, ponzu, actor, cache, designId]);
  return open && open.id === designId ? open : null;
}

export function useSourceState(source: CloudSource) {
  return useSyncExternalStore(
    (changed) => source.subscribe(changed),
    () => source.getState(),
  );
}

/**
 * What the viewer may do with the open design, once the API has said: look, or also steer.
 * Null until then, so nothing offers to steer that can't, or hides what can.
 */
export function useAccess(open: OpenDesign): "read" | "write" | null {
  const state = useSourceState(open.source);
  // The API's word arrives with the replica, and holds while the network comes and goes; a copy
  // shown offline before it doesn't carry it.
  const known = useRef<{ id: string; access: "read" | "write" } | null>(null);
  if (state.status === "ready") {
    known.current = { id: open.id, access: open.source.writable ? "write" : "read" };
  }
  return known.current?.id === open.id ? known.current.access : (open.fresh?.access ?? null);
}

/** The chrome past the left block for an open design. */
export function DesignChromeSlot({
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
}: {
  open: OpenDesign;
  /** Its sidebar row, once the list has it. */
  summary: DesignSummary | null;
  me: Person;
  /** Its owner among the workspace's members. */
  owner: Person | null;
  workspaceKind: WorkspaceKind;
  members: DesignMember[];
  sidebarOpen: boolean;
  page: string | null;
  onPage: (id: string) => void;
  rail: { open: boolean; onToggle: () => void };
  /** The pull request tab, open in the canvas's pane in place of the page. */
  prTab: { open: boolean; onToggle: () => void };
  /** How far the viewer has read the thread, for the rail toggle's dot. */
  seenThreadSeq: number | null;
  onOpenRepo: (fullName: string) => void;
}) {
  const state = useSourceState(open.source);
  const head = useLiveQuery("design.head", { designId: open.id }).rows?.[0];
  const presence = useLiveQuery("design.presence", { designId: open.id }).rows ?? [];
  const meRow = useLiveQuery("me", {}).rows?.[0];
  const thread = useSnapshot(open.thread);
  const pull = useSnapshot(open.pullRequest);
  const access = useAccess(open);
  const now = useNow();
  const doc = state.doc;
  const pages = doc ? pageTabs(doc.pages, head?.agentArtboards ?? []) : [];
  const project = summary?.project ?? null;
  const repo = project?.kind === "repo" ? project.repo : null;
  usePullRequestReads(open, repo !== null, head, thread.items);

  // The mark from the design's head, live; until the head has come, from what the sidebar's row
  // already says (the same columns), with what the last read of GitHub said of whether it can
  // merge. So a design opens with its mark at once, and the head confirms it without a change.
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
  return (
    <DesignChrome
      name={head?.name ?? summary?.name ?? doc?.name ?? open.fresh?.name ?? ""}
      sidebarOpen={sidebarOpen}
      pages={pages}
      activePageId={prTab.open ? null : (page ?? pages[0]?.id ?? null)}
      onSelectPage={(id) => {
        if (prTab.open) prTab.onToggle();
        onPage(id);
      }}
      onAddPage={
        doc && access === "write"
          ? () => {
              const id = newId("pg");
              open.source.apply({
                op: "page.create",
                index: doc.pages.length,
                page: { id, name: `Page ${doc.pages.length + 1}` },
              });
              onPage(id);
            }
          : null
      }
      team={
        workspaceKind === "org" && project?.kind === "repo"
          ? {
              meId: me.id,
              contributors: contributors(presentNow(presence, now), me, worked),
              repo: project.repo,
              members,
              onOpenRepo: () => onOpenRepo(`${project.repo.owner}/${project.repo.name}`),
            }
          : null
      }
      pullRequest={repo && pr ? { pr, tabOpen: prTab.open, onToggleTab: prTab.onToggle } : null}
      action={
        kind
          ? {
              kind,
              busy: pull.busy !== null,
              blocked: actionBlock(kind, gate, me.id) ?? (pull.asked === kind ? ASKED : null),
              onRun: (action) => open.pullRequest.run(action),
            }
          : null
      }
      rail={{ open: rail.open, signal, onToggle: rail.onToggle }}
      actionExpected={expected}
    />
  );
}

/**
 * Reads the pull request as the design opens (at once, not waiting for its head), and again
 * when what the head says of it changes, when the agent's state changes or a stretch of its
 * work ends (it may have pushed), when the thread says a pull request opened, merged or closed,
 * and on coming back to the window. A Scratch design (no `repo`) has none to read.
 */
function usePullRequestReads(
  open: OpenDesign,
  repo: boolean,
  head: DesignHeadRow | undefined,
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

type RunnerItem = LiveRows["design.thread"];

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

/** The canvas pane for an open design, with what can go wrong said over it. */
export function DesignCanvas({
  host,
  open,
  me,
  page,
  onPage,
  link,
  onClose,
}: {
  host: Host;
  open: OpenDesign;
  me: Person;
  page: string | null;
  onPage: (id: string) => void;
  /** Where a link, or a line of the thread, asked to show it. */
  link?: CanvasProps["link"];
  /** Leave it: back to the create page. */
  onClose: () => void;
}) {
  const { source, id } = open;
  const state = useSourceState(source);
  const theme = useColorScheme();
  const head = useLiveQuery("design.head", { designId: id });
  const seq = head.rows?.[0]?.seq;
  // A design you can open always has its head row: none, live, is one deleted or taken away.
  const gone = state.status === "error" || (head.status === "live" && head.rows?.length === 0);
  const unsaved = useUnsaved(source);
  const analytics = useAnalytics();

  // The person has seen it as it stands: the sidebar's dot goes.
  useEffect(() => {
    if (seq === undefined || state.status !== "ready") return;
    const timer = setTimeout(() => void host.api.designs.seen(id).catch(() => {}), 1000);
    return () => clearTimeout(timer);
  }, [host, id, seq, state.status]);

  // The page each tab shows is the chrome's; the others hear it through presence.
  useEffect(() => {
    source.setPage(page);
  }, [source, page]);

  // The network is back: don't wait out the retry.
  useEffect(() => {
    const online = () => source.retryNow();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [source]);

  if (gone) {
    return (
      <PaneMessage
        title="This design isn't here any more"
        body="It was deleted, or you no longer have access to its repo on GitHub."
        action={{ label: "Back to designs", onClick: onClose }}
      />
    );
  }
  if (!state.doc) {
    return state.status === "offline" ? (
      <PaneMessage
        title="Can't reach Ponzu"
        body="This design opens as soon as you're back online."
        busy
      />
    ) : open.fresh ? (
      // Just made on the create page: its dotted ground stays until the canvas draws its own.
      <div className="canvas-dots absolute inset-0" />
    ) : null;
  }
  return (
    <>
      <Canvas
        source={source}
        me={{
          kind: "user",
          id: me.id,
          name: me.name,
          ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
        }}
        theme={theme}
        readOnly={!source.writable}
        pageBar={false}
        {...(page ? { page } : {})}
        onPageChange={onPage}
        {...(link ? { link } : {})}
        onModeChange={(mode) => {
          if (mode === "comment") analytics.capture("comment mode entered", { design_id: id });
        }}
      />
      {state.status === "offline" ? (
        <Banner>You're offline. Your changes are kept here and sent when you're back.</Banner>
      ) : unsaved ? (
        <Banner>{unsaved.reason}</Banner>
      ) : null}
    </>
  );
}

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
