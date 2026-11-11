import { Canvas } from "@ponzu/canvas";
import { type DesignHeadRow, DocCache, type LiveRows, presentNow } from "@ponzu/client";
import { CloudSource, type Unsaved } from "@ponzu/client/canvas";
import { useLiveQuery } from "@ponzu/client/react";
import { type Actor, newId } from "@ponzu/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DesignMember, DesignSummary, Person, WorkspaceKind } from "../cloud/model.ts";
import { actionBlock } from "../cloud/pull-request.ts";
import { railSignal } from "../cloud/status.ts";
import { useNow } from "../cloud/time.ts";
import { useColorScheme } from "../cloud/ui/color-scheme.ts";
import { DesignChrome } from "../cloud/window/design-chrome.tsx";
import { AskStore } from "./ask-store.ts";
import type { Host } from "./host.ts";
import { contributors, pageTabs } from "./map.ts";
import { Banner, PaneMessage } from "./notices.tsx";
import { chromeAction, prSummary } from "./pull-request-map.ts";
import { PullRequestStore } from "./pull-request-store.ts";
import { steerGate } from "./thread-map.ts";
import { ThreadStore } from "./thread-store.ts";
import { Uploads } from "./uploads.ts";
import { useOnReturn } from "./use-answer.ts";
import { useSnapshot } from "./use-snapshot.ts";

/*
 * An open design: the canvas on a `CloudSource`, and the chrome over it, both driven by the
 * same source and the design's live head; its thread, what its agent waits on, the images on
 * their way into a message, and its pull request. All of them live as long as the design is open.
 */

export interface OpenDesign {
  id: string;
  source: CloudSource;
  thread: ThreadStore;
  asks: AskStore;
  uploads: Uploads;
  pullRequest: PullRequestStore;
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
): OpenDesign | null {
  const [open, setOpen] = useState<OpenDesign | null>(null);
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
  useEffect(() => {
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
    const thread = new ThreadStore({ api, live, designId }).start();
    const asks = new AskStore({ api, live, designId, onError: (m) => saying.current(m) }).start();
    const uploads = new Uploads({ api, designId });
    const pullRequest = new PullRequestStore({
      api,
      designId,
      say: (m) => saying.current(m),
      tellAgent: (text) => thread.send(text, []),
    });
    setOpen({ id: designId, source, thread, asks, uploads, pullRequest });
    return () => {
      source.close();
      thread.close();
      asks.close();
      uploads.close();
      pullRequest.close();
    };
  }, [host, actor, cache, designId]);
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
  if (state.status === "connecting" || state.status === "error") return null;
  // The API's word arrives with the replica; a copy shown offline doesn't carry it.
  return open.source.assetBase && state.status === "ready"
    ? open.source.writable
      ? "write"
      : "read"
    : null;
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
  usePullRequestReads(open, repo ? head : undefined);

  const pr = prSummary(head);
  const kind = repo && pull.tab ? chromeAction(pull.tab) : null;
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
      name={head?.name ?? summary?.name ?? doc?.name ?? ""}
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
              blocked: actionBlock(kind, gate, me.id),
              onRun: (action) => open.pullRequest.run(action),
            }
          : null
      }
      rail={{ open: rail.open, signal, onToggle: rail.onToggle }}
    />
  );
}

/**
 * Reads the pull request when the design opens, and again when what the head says of it
 * changes, when a turn of the agent's ends (it may have pushed), and on coming back to the
 * window. A Scratch design (no `head` given) has none to read.
 */
function usePullRequestReads(open: OpenDesign, head: DesignHeadRow | undefined) {
  const turn = head?.agentState === "working" || head?.agentState === "waking";
  const key = head
    ? [head.prNumber, head.prState, head.prChecks, head.prMergeable, head.prAutoMerge, turn].join()
    : null;
  useEffect(() => {
    if (key === null) return;
    // A burst of changes (a push and its checks starting) is one read.
    const timer = setTimeout(() => open.pullRequest.refresh(), READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [open, key]);
  useOnReturn(() => {
    if (key !== null) open.pullRequest.refresh();
  }, RETURN_READ_MS);
}

const READ_AFTER_MS = 300;
const RETURN_READ_MS = 30_000;

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
  link?: { page?: string; artboard?: string; at?: number };
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
