import { useLiveQuery } from "@ponzu/client/react";
import { useCallback, useEffect, useMemo } from "react";
import type { Person, Repo, ThreadItem } from "../cloud/model.ts";
import { ThreadRail } from "../cloud/thread/rail.tsx";
import { ThreadSkeleton } from "../cloud/thread/thread-view.tsx";
import { useNow } from "../cloud/time.ts";
import { useColorScheme } from "../cloud/ui/color-scheme.ts";
import { BoardMiniature } from "./board-miniature.tsx";
import { type OpenDesign, useAccess, useSourceState } from "./design.tsx";
import type { Host } from "./host.ts";
import {
  agentActivity,
  shownItems,
  steerGate,
  type ThreadContext,
  toThreadItem,
} from "./thread-map.ts";
import type { PendingMessage } from "./thread-store.ts";
import { useSnapshot } from "./use-snapshot.ts";

/*
 * The thread rail of an open design on live data (AppWindow's `rail`): its thread, what its agent
 * is doing, what it waits on in the composer's place, and the composer, with every send, answer,
 * upload and stop going to the API through the open design's stores.
 */

export function DesignRail({
  host,
  open,
  me,
  people,
  repo,
  owner,
  onOpenArtboards,
  onOpenPullRequest,
  onConnectClaude,
  say,
}: {
  host: Host;
  open: OpenDesign;
  me: Person;
  /** The workspace's members by id. */
  people: ReadonlyMap<string, Person>;
  /** Its repo; null for Scratch. */
  repo: Repo | null;
  owner: Person | null;
  /** Shows these boards on the canvas. */
  onOpenArtboards: (artboardIds: string[]) => void;
  onOpenPullRequest: () => void;
  /** Connects the viewer's own Claude, when the design waits on it; absent until it can. */
  onConnectClaude?: () => void;
  /** Says over the window what didn't happen. */
  say: (notice: string) => void;
}) {
  const designId = open.id;
  const state = useSourceState(open.source);
  const access = useAccess(open);
  const thread = useSnapshot(open.thread);
  const asks = useSnapshot(open.asks);
  const attachments = useSnapshot(open.uploads);
  const head = useLiveQuery("design.head", { designId }).rows?.[0];
  const meRow = useLiveQuery("me", {}).rows?.[0];
  const theme = useColorScheme();
  const now = useNow();
  const doc = state.doc;
  const assetBase = open.source.assetBase;

  // A question waiting in the composer's place isn't in the thread as well.
  const waiting = useMemo(
    () =>
      new Set(
        asks.filter((ask) => ask.status === "open" || ask.status === "sending").map((a) => a.id),
      ),
    [asks],
  );
  const items = useMemo(() => {
    // A design just made shows its first message while its thread is read.
    if (!thread.items && !thread.pending.length) return null;
    const ctx: ThreadContext = { people, assetsUrl: assetBase ?? null, doc };
    return [
      ...shownItems(thread.items ?? [], waiting).map((item) => toThreadItem(item, ctx)),
      ...thread.pending.map((message, i) => pendingItem(message, me, i)),
    ];
  }, [thread, waiting, people, assetBase, doc, me]);

  // With the rail open, the viewer has read the thread as far as it goes.
  const newest = thread.items?.at(-1)?.seq;
  useEffect(() => {
    if (newest === undefined || access === null) return;
    const timer = setTimeout(
      () => void host.api.designs.seen(designId, { threadSeq: newest }).catch(() => {}),
      1000,
    );
    return () => clearTimeout(timer);
  }, [host, designId, newest, access]);

  const onOpenComment = useCallback(
    (threadId: string) => {
      const artboard = doc?.threads.find((t) => t.id === threadId)?.artboardId;
      if (artboard) onOpenArtboards([artboard]);
    },
    [doc, onOpenArtboards],
  );

  // Until the API says what the viewer may do, nothing offers to steer.
  if (access === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ThreadSkeleton />
      </div>
    );
  }
  const gate = steerGate({ access, repo, head, owner, me: meRow, now });
  return (
    <ThreadRail
      designId={designId}
      meId={me.id}
      repoName={repo?.name ?? null}
      items={items}
      older={thread.older}
      onLoadOlder={() => open.thread.loadOlder()}
      agent={agentActivity(head ?? open.fresh?.head)}
      asks={asks}
      gate={gate}
      attachments={attachments}
      onAttach={(files) => open.uploads.add(files)}
      onRemoveAttachment={(id) => open.uploads.remove(id)}
      onRetryAttachment={(id) => open.uploads.retry(id)}
      onSend={(text) => open.thread.send(text.trim(), open.uploads.take())}
      onStop={() =>
        void host.api.designs
          .stop(designId)
          .catch(() => say("Claude couldn't be stopped. Try again."))
      }
      onAnswer={(id, answer) => open.asks.answer(id, answer)}
      onDismissAsk={(id) => open.asks.dismiss(id)}
      onTouchAsk={(id) => open.asks.touch(id)}
      onRetryMessage={(id) => open.thread.retry(id)}
      onEditMessage={(id) => open.thread.discard(id)}
      {...(onConnectClaude ? { onConnectClaude } : {})}
      renderBoard={(artboardId) => (
        <BoardMiniature doc={doc} artboardId={artboardId} assetBase={assetBase} theme={theme} />
      )}
      onOpenComment={onOpenComment}
      onOpenArtboards={onOpenArtboards}
      onOpenPullRequest={onOpenPullRequest}
      onOpenLink={(url) => host.openExternal(url)}
    />
  );
}

/** A message of the viewer's on its way, at the thread's foot until it arrives. */
function pendingItem(message: PendingMessage, me: Person, index: number): ThreadItem {
  return {
    id: message.id,
    // After everything the thread holds, in the order they were sent.
    seq: Number.MAX_SAFE_INTEGER - 1000 + index,
    at: message.at,
    streaming: false,
    kind: "message",
    payload: {
      text: message.text,
      from: me,
      attachments: message.attachments,
      delivery: message.status,
    },
  };
}
