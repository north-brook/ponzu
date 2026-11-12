import { useLiveQuery } from "@ponzu/client/react";
import { linkTarget } from "@ponzu/core";
import { useMutation, useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import type { Person, Repo, ThreadItem } from "../cloud/model.ts";
import { ThreadRail } from "../cloud/thread/rail.tsx";
import { ThreadSkeleton } from "../cloud/thread/thread-view.tsx";
import { useNow } from "../cloud/time.ts";
import type { CanvasAddress } from "../cloud/ui/canvas-address.ts";
import { useColorScheme } from "../cloud/ui/color-scheme.ts";
import { type CanvasPlaces, CanvasPlacesProvider } from "../cloud/ui/place-link.tsx";
import { type OpenCanvas, useAccess, useSourceState } from "./canvas.tsx";
import { CommentScene } from "./comment-picture.tsx";
import type { Host } from "./host.ts";
import { usePonzu } from "./ponzu-query.tsx";
import { takeOverRefusal } from "./take-over.ts";
import {
  agentActivity,
  answerLine,
  closedQuestions,
  shownItems,
  steerGate,
  type ThreadContext,
  toThreadItem,
} from "./thread-map.ts";
import type { PendingMessage } from "./thread-store.ts";
import { useSnapshot } from "./use-snapshot.ts";

/** Where the canvas goes for a comment (the canvas's `link`). */
export interface CommentLink {
  thread: string;
  page?: string;
  artboard?: string;
  spot?: { x: number; y: number };
}

/*
 * The thread rail of an open canvas on live data (AppWindow's `rail`): its thread, what its agent
 * is doing, what it waits on in the composer's place, and the composer, with every send, answer,
 * upload and stop going to the API through the open canvas's stores.
 */

export function CanvasRail({
  host,
  open,
  me,
  people,
  repo,
  owner,
  onOpenArtboards,
  onOpenComment,
  onOpenPlace,
  onOpenPullRequest,
  onConnectClaude,
  say,
}: {
  host: Host;
  open: OpenCanvas;
  me: Person;
  /** The workspace's members by id. */
  people: ReadonlyMap<string, Person>;
  /** Its repo; null for Scratch. */
  repo: Repo | null;
  owner: Person | null;
  /** Shows these boards on the canvas. */
  onOpenArtboards: (artboardIds: string[]) => void;
  /** Takes the canvas to a comment, or to where it was when its thread is gone. */
  onOpenComment: (to: CommentLink) => void;
  /** Shows a page or board a link in the agent's words points at, in this canvas or another. */
  onOpenPlace: (at: CanvasAddress) => void;
  onOpenPullRequest: () => void;
  /**
   * Connects the viewer's own Claude, when the canvas waits on it; absent until it can. Says
   * whether its sign-in ran out, so the dialog puts it as the strip did.
   */
  onConnectClaude?: (expired: boolean) => void;
  /** Says over the window what didn't happen. */
  say: (notice: string) => void;
}) {
  const canvasId = open.id;
  const { queries, mutations } = usePonzu();
  const stop = useMutation(mutations.stopAgent());
  const takeOver = useMutation(mutations.takeOver());
  const state = useSourceState(open.source);
  const access = useAccess(open);
  const thread = useSnapshot(open.thread);
  const asked = useSnapshot(open.asks);
  // Who answered, as the member they are: with their picture, when the workspace has them.
  const asks = useMemo(
    () =>
      asked.map((ask) =>
        ask.answeredBy
          ? { ...ask, answeredBy: people.get(ask.answeredBy.id) ?? ask.answeredBy }
          : ask,
      ),
    [asked, people],
  );
  const attachments = useSnapshot(open.uploads);
  const pictures = useSnapshot(open.pictures);
  const head = useLiveQuery("canvas.head", { canvasId }).rows?.[0];
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
  // Each closed question's line says what was picked: read once it has left the slot.
  const shown = useMemo(() => shownItems(thread.items ?? [], waiting), [thread.items, waiting]);
  const closedIds = useMemo(() => closedQuestions(shown), [shown]);
  const picked = useQueries({
    queries: closedIds.map((id) => ({
      ...queries.question(canvasId, id),
      // A closed question stays as it closed; one read while still open is read again.
      staleTime: (q: { state: { data?: { status: string } } }) =>
        q.state.data?.status === "open" ? 0 : Number.POSITIVE_INFINITY,
      refetchInterval: (q: { state: { data?: { status: string } } }) =>
        q.state.data?.status === "open" ? 5_000 : false,
    })),
    combine: (results) => JSON.stringify(results.map((r) => answerLine(r.data))),
  });
  const answers = useMemo(() => {
    const lines = JSON.parse(picked) as (string | null)[];
    return new Map(closedIds.map((id, i) => [id, lines[i] ?? null] as const));
  }, [picked, closedIds]);
  const items = useMemo(() => {
    // A canvas just made shows its first message while its thread is read.
    if (!thread.items && !thread.pending.length) return null;
    const ctx: ThreadContext = { people, assetsUrl: assetBase ?? null, doc, pictures };
    return [
      ...shown.map((item) => withAnswer(toThreadItem(item, ctx), answers)),
      ...thread.pending.map((message, i) => pendingItem(message, me, i)),
    ];
  }, [thread, shown, answers, people, assetBase, doc, me, pictures]);

  // With the rail open, the viewer has read the thread as far as it goes.
  const newest = thread.items?.at(-1)?.seq;
  useEffect(() => {
    if (newest === undefined || access === null) return;
    const timer = setTimeout(
      () => void host.api.canvases.seen(canvasId, { threadSeq: newest }).catch(() => {}),
      1000,
    );
    return () => clearTimeout(timer);
  }, [host, canvasId, newest, access]);

  // To the comment, resolved or not; to where it was, once its thread has been deleted.
  const openComment = useCallback(
    (threadId: string, messageId: string) => {
      const item = shown.find(
        (candidate) => candidate.kind === "comment" && candidate.payload.messageId === messageId,
      );
      const left = item?.kind === "comment" ? item.payload : null;
      const there = doc?.threads.some((t) => t.id === threadId) ?? true;
      if (!there) say("That comment was deleted. This is where it was.");
      onOpenComment({
        thread: threadId,
        ...(left?.pageId ? { page: left.pageId } : {}),
        ...(left?.artboardId ? { artboard: left.artboardId } : {}),
        ...(left?.at ? { spot: left.at } : {}),
      });
    },
    [shown, doc, onOpenComment, say],
  );

  // What a link in the agent's words can find: the canvas as it is now, while it streams too.
  const places = useMemo<CanvasPlaces>(
    () => ({
      canvasId,
      has: (at) => (doc ? linkTarget(doc, at) !== null : undefined),
      open: onOpenPlace,
    }),
    [canvasId, doc, onOpenPlace],
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
    <CanvasPlacesProvider value={places}>
      <ThreadRail
        canvasId={canvasId}
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
          stop.mutate(canvasId, { onError: () => say("Claude couldn't be stopped. Try again.") })
        }
        onAnswer={(id, answer) => open.asks.answer(id, answer)}
        onDismissAsk={(id) => open.asks.dismiss(id)}
        onTouchAsk={(id) => open.asks.touch(id)}
        onRetryMessage={(id) => open.thread.retry(id)}
        onEditMessage={(id) => open.thread.discard(id)}
        {...(onConnectClaude
          ? { onConnectClaude: () => onConnectClaude(gate?.kind === "claude_expired") }
          : {})}
        onTakeOver={() =>
          takeOver.mutate(canvasId, { onError: (error) => say(takeOverRefusal(error)) })
        }
        takingOver={takeOver.isPending}
        renderDrawing={(messageId) => {
          const local = pictures.get(messageId);
          return local?.state === "drawing" ? (
            <CommentScene
              doc={local.doc}
              threadId={local.threadId}
              messageId={messageId}
              theme={theme}
              assetBase={assetBase}
            />
          ) : null;
        }}
        onOpenComment={openComment}
        onOpenArtboards={onOpenArtboards}
        onOpenPullRequest={onOpenPullRequest}
        onOpenLink={(url) => host.openExternal(url)}
      />
    </CanvasPlacesProvider>
  );
}

/** A question's line with what was picked, once that is known. */
function withAnswer(item: ThreadItem, answers: ReadonlyMap<string, string | null>): ThreadItem {
  if (item.kind !== "notice" || item.payload.type !== "question") return item;
  const answer = answers.get(item.payload.questionId);
  return answer ? { ...item, payload: { ...item.payload, answer } } : item;
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
