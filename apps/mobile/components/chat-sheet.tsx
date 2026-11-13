import type { CanvasHeadRow } from "@ponzu/client";
import {
  type AskAnswer,
  driverNoticeLine,
  ERROR_COPY,
  ERROR_DETAIL,
  type LocalPicture,
  membersById,
  modelChangedLine,
  ownerChangedLine,
  type Person,
  SENT_GRACE_MS,
  type ThreadItem,
  type ThreadNotice,
  type ThreadRow,
  who,
} from "@ponzu/client/model";
import type { Doc } from "@ponzu/core";
import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  type ChatFoot,
  chatFoot,
  chatItems,
  chatRows,
  readTo,
  revealRow,
  sendFailed,
} from "../lib/chat/lines";
import { revealStep } from "../lib/chat/thread-store";
import { useAsks } from "../lib/chat/use-asks";
import { useThread } from "../lib/chat/use-thread";
import { backend } from "../lib/cloud/backend";
import { useWorkspaces } from "../lib/cloud/canvases";
import { useCloud } from "../lib/cloud/query";
import { CHAT } from "../lib/copy";
import { draftKey } from "../lib/drafts";
import { fail, select, success, tick } from "../lib/haptics";
import { Markdown } from "../lib/markdown";
import { type Picked, pickImages, uploadImages } from "../lib/pick-images";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";
import { brand, font } from "../lib/tokens";
import { Composer, type ComposerHandle, type Mode } from "./composer";
import { AlertCircle, Close, Plus } from "./icons";
import { NeedsYou } from "./needs-you";
import { Sheet } from "./sheet";

/** The canvas's view, as far as the chat reads it. */
export interface ChatCanvas {
  workspaceId: string;
  ownerId: string | null;
  assetsUrl: string;
}

/** How wide a comment's picture shows in the thread, and how tall at most: the Mac's sizes. */
const PICTURE_WIDTH = 144;
const PICTURE_MAX_HEIGHT = 108;
export function pictureSize(width: number, height: number) {
  const shown = Math.min(PICTURE_WIDTH, width);
  return {
    width: shown,
    height: Math.min(PICTURE_MAX_HEIGHT, Math.round((shown * height) / width)),
  };
}

/**
 * The chat sheet (iPhone design §9): the canvas's one thread, near full height over the header's
 * glass, holding a grabber, the thread and the composer, and nothing else.
 *
 * The thread is the live tail beside the newest page of history (older pages as it is scrolled
 * to the top), drawn by the Mac's rules (lib/chat/lines.ts): a person's message is a bubble on
 * the right, with its sender's avatar on its corner once more than one person has written; a
 * comment is the picture of where it was left above its bubble, and pressing it goes to the pin;
 * Ponzu's reply is plain text from Markdown (lib/markdown.tsx), its asides quieter and in
 * italics while the turn runs, and no tool calls. At the foot, while a turn is live, the turning
 * slice and what the agent is doing, or what keeps the canvas waiting, in plain words.
 *
 * The composer: Attach (pictures from the library, uploaded as the message's), the field (typed
 * or said), and the right button: Send when there are words, Stop while a turn is live and the
 * field is empty. A message mid-run goes straight in. A send that doesn't go keeps its words and
 * pictures, with "Couldn't send. Tap to try again." under the field.
 *
 * While the agent waits on a person, what it asks takes the composer's place (needs-you.tsx,
 * iPhone design §10): answered there, its live row goes and the composer is back. An ask someone
 * else answered first leaves, with one line under the slot saying so.
 */
export function ChatSheet({
  canvasId,
  head,
  canvas,
  doc,
  me,
  pictures,
  readOnly,
  offline,
  focus,
  message,
  question,
  repoName,
  onDismiss,
  onOpenComment,
  onOpenLink,
  onOpenPullRequest,
  top,
  right,
  maxWidth,
  bottomBar,
  panel,
  closing = false,
}: {
  canvasId: string;
  head: CanvasHeadRow | undefined;
  canvas: ChatCanvas | undefined;
  doc: Doc | null;
  me: Person;
  /**
   * The pictures of the person's own comments sent from this phone, by message id, drawn here
   * (lib/canvas/pictures.ts): shown before, and instead of, loading the kept ones.
   */
  pictures?: ReadonlyMap<string, LocalPicture>;
  /** Why the person can't steer (read access, or the last copy offline): in the field's place. */
  readOnly: string | null;
  /** The phone can't reach Ponzu now: sending waits, and the field says so. */
  offline: string | null;
  /** Opened by the Chat button with no question showing: the field takes the keyboard. */
  focus: boolean;
  /** A message to open at, by its seq (a link's or a push's `message`). */
  message: number | null;
  /** A question to open at, by its id (a push's `question`). */
  question: string | null;
  /** The canvas's repo, where a secret it asks for is kept; null for Scratch. */
  repoName: string | null;
  /** Gone, with the newest seq of the thread it held: how far the person has read it. */
  onDismiss: (readSeq: number | null) => void;
  /**
   * A comment's picture was pressed: the sheet goes, and the canvas goes to its pin. With the
   * newest seq the thread held, since leaving this way is closing it too.
   */
  onOpenComment: (threadId: string, readSeq: number | null) => void;
  /** A link in a reply was pressed, with the newest seq the thread held, as for a comment. */
  onOpenLink: (url: string, readSeq: number | null) => void;
  /** A pull request line was pressed: the sheet goes, and the pull request sheet opens. */
  onOpenPullRequest: (readSeq: number | null) => void;
  top: number;
  right?: number;
  maxWidth?: number;
  bottomBar?: number;
  /** Docked beside the canvas this wide (components/sheet.tsx `panel`), in a window with room. */
  panel?: number;
  /** Asked to go (Chat pressed again while it's docked): it leaves as a swipe would. */
  closing?: boolean;
}) {
  const { color } = useTheme();
  const cloud = useCloud();
  const { store, thread } = useThread(canvasId);
  const { store: askStore, asks } = useAsks(canvasId);
  const openAsks = asks.open;
  const members = useQuery({
    ...cloud.queries.workspace(canvas?.workspaceId ?? ""),
    enabled: Boolean(canvas?.workspaceId) && cloud.userId !== null,
  });
  const people = useMemo(
    () => (members.data ? membersById(members.data.members) : new Map<string, Person>()),
    [members.data],
  );
  const { workspaces } = useWorkspaces();
  const shown = workspaces?.find((w) => w.id === canvas?.workspaceId);
  const workspace = shown ? { name: shown.name, personal: shown.kind === "personal" } : null;
  const items = useMemo(
    () =>
      chatItems({
        items: thread.items,
        pending: thread.pending,
        openAsks,
        context: {
          people,
          assetsUrl: canvas?.assetsUrl ?? null,
          doc,
          ...(pictures ? { pictures } : {}),
        },
        me,
      }),
    [thread.items, thread.pending, openAsks, people, canvas?.assetsUrl, doc, me, pictures],
  );
  const rows = useMemo(() => chatRows(items, head), [items, head]);
  // "Thinking" after a send lasts its grace and no longer: draw again when it ends.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const said = items.findLast((i) => i.kind === "message" || i.kind === "comment");
    if (!said) return;
    const left = Date.parse(said.at) + SENT_GRACE_MS - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(timer);
  }, [items]);
  const foot = chatFoot({
    items,
    head,
    // Unknown until the canvas and its workspace's members are in: never "its owner left" for
    // a list that hasn't come yet.
    owner: !canvas
      ? undefined
      : !canvas.ownerId
        ? null
        : members.data
          ? (people.get(canvas.ownerId) ?? null)
          : undefined,
    meId: me.id,
    workspace,
    now: Math.max(now, Date.now()),
  });

  /* The composer. */
  const [mode, setMode] = useState<Mode>("type");
  const [picked, setPicked] = useState<Picked[]>([]);
  const [line, setLine] = useState<string | null>(null);
  const [lineRetries, setLineRetries] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const running = head?.agentState === "working" || head?.agentState === "waking";
  const attach = async () => {
    select();
    const more = await pickImages(picked.length);
    if (more.length) setPicked((now) => [...now, ...more]);
  };
  const send = async (text: string) => {
    if (!store) throw new Error("The thread isn't open yet.");
    const pictures = picked;
    setLine(null);
    askStore?.clearSaid();
    setPicked([]);
    try {
      const uploaded = await uploadImages(backend.api, canvasId, pictures);
      await store.send(
        text,
        uploaded.map(({ picked: p, ref }) => ({ ref, uri: p.uri, contentType: p.type })),
      );
    } catch (error) {
      // The words go back in the field (the composer's), the pictures back over it.
      setPicked((now) => [...pictures, ...now]);
      setLine(sendFailed(error));
      setLineRetries(true);
      throw error;
    }
  };
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (stopping) return;
    tick();
    setStopping(true);
    setLine(null);
    try {
      await backend.api.canvases.stop(canvasId);
    } catch {
      fail();
      setLine(CHAT.stopFailed);
      setLineRetries(false);
    } finally {
      setStopping(false);
    }
  };

  /* The list: it follows the newest line while the person is at the end of it. */
  const list = useRef<FlatList<ThreadRow>>(null);
  const atEnd = useRef(true);
  const revealed = useRef(false);
  const pages = useRef(0);
  // A later link or ping naming another message, while the sheet is up, is shown in its turn.
  const revealing = useRef(message);
  if (revealing.current !== message) {
    revealing.current = message;
    revealed.current = false;
    pages.current = 0;
  }
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
    if (contentOffset.y < 120) store?.loadOlder();
  };
  // A message a link names: older pages until it is held, then it comes into view, once.
  useEffect(() => {
    if (message === null || revealed.current) return;
    const step = revealStep(thread, message, pages.current);
    if (step === "page") {
      pages.current += 1;
      store?.loadOlder();
    } else if (step === "show" && rows.length) {
      revealed.current = true;
      atEnd.current = false;
      const index = revealRow(rows, message);
      requestAnimationFrame(() =>
        list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.2 }),
      );
    }
  }, [thread, rows, message, store]);

  // A link or a comment's picture closes the sheet as a swipe does: the thread is read as far
  // as it held. Stable, so the memoized lines don't redraw for them.
  const readSeq = useRef<number | null>(null);
  readSeq.current = readTo(thread.items);
  // Closed from outside (the stack's Chat, the chat docked): read as far as it held, as a swipe.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (closing) dismiss.current(readSeq.current);
  }, [closing]);
  const leave = useRef({ onOpenComment, onOpenLink, onOpenPullRequest });
  leave.current = { onOpenComment, onOpenLink, onOpenPullRequest };
  const openComment = useCallback(
    (id: string) => leave.current.onOpenComment(id, readSeq.current),
    [],
  );
  const openLink = useCallback((url: string) => leave.current.onOpenLink(url, readSeq.current), []);
  const openPullRequest = useCallback(() => leave.current.onOpenPullRequest(readSeq.current), []);

  const writable = !readOnly;
  // What the agent asks, in the composer's place, once the live rows say anything is open.
  const asking = asks.asks.length > 0;
  const answer = (id: string, given: AskAnswer) => {
    void askStore?.answer(id, given).then((ok) => (ok ? success() : fail()));
  };
  // Under the slot: what became of an answer, else what became of a message or Stop.
  const said = asks.said ?? (line ? { id: -1, text: line, failed: true } : null);
  const retries = !asks.said && lineRetries;
  const empty = thread.items !== null && rows.length === 0;
  return (
    <Sheet
      testID="chat-sheet"
      onDismiss={() => onDismiss(readTo(thread.items))}
      top={top}
      gap={10}
      right={right}
      maxWidth={maxWidth}
      bottomBar={bottomBar}
      panel={panel}
    >
      <FlatList
        ref={list}
        testID="chat-thread"
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: 14, paddingTop: 8, paddingBottom: 4 }}
        data={rows}
        keyExtractor={(row) => row.item.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          if (atEnd.current) list.current?.scrollToEnd({ animated: false });
        }}
        onScrollToIndexFailed={({ averageItemLength, index }) => {
          list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
          requestAnimationFrame(() =>
            list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.2 }),
          );
        }}
        renderItem={({ item: row }) => (
          <ChatLine
            row={row}
            meId={me.id}
            onOpenComment={openComment}
            onOpenLink={openLink}
            onOpenPullRequest={openPullRequest}
          />
        )}
        ListEmptyComponent={
          empty || thread.failed ? (
            <Quiet testID="chat-empty">{thread.failed ? CHAT.unreachable : CHAT.empty}</Quiet>
          ) : undefined
        }
        ListFooterComponent={foot ? <Foot foot={foot} /> : undefined}
      />
      {writable && !asking && picked.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 8, paddingTop: 6, paddingHorizontal: 2 }}
        >
          {picked.map((image) => (
            <View key={image.id}>
              <Image
                source={{ uri: image.uri }}
                accessibilityIgnoresInvertColors
                style={{ width: 56, height: 56, borderRadius: 10 }}
              />
              <Pressable
                testID={`chat-remove-${image.id}`}
                accessibilityRole="button"
                accessibilityLabel={CHAT.remove(image.name)}
                hitSlop={10}
                onPress={() => setPicked((now) => now.filter((p) => p.id !== image.id))}
                style={{
                  position: "absolute",
                  top: -6,
                  right: -6,
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: color.ink,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Close color={color.bg} size={12} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      {asking ? (
        <NeedsYou
          asks={asks.asks}
          start={question}
          repoName={repoName}
          blocked={readOnly ?? offline}
          onAnswer={answer}
          onTouch={(id) => askStore?.touch(id)}
          onOpenLink={openLink}
        />
      ) : writable && !offline ? (
        <Composer
          name="chat"
          mode={mode}
          onMode={setMode}
          placeholder={CHAT.placeholder}
          onSend={send}
          autoFocus={focus}
          handle={composer}
          draft={{ key: draftKey.chat(canvasId), file: canvasId }}
          onStop={running && picked.length === 0 ? () => void stop() : undefined}
          leading={
            <Pressable
              testID="chat-attach"
              accessibilityRole="button"
              accessibilityLabel={CHAT.attach}
              hitSlop={8}
              onPress={attach}
              style={{ width: 32, height: 32, alignItems: "center", justifyContent: "center" }}
            >
              <Plus size={20} color={color.muted} />
            </Pressable>
          }
        />
      ) : (
        <Quiet testID="chat-read-only">{readOnly ?? offline}</Quiet>
      )}
      {said && writable && (
        <Pressable
          testID="chat-line"
          accessibilityRole={retries ? "button" : "text"}
          accessibilityLiveRegion="polite"
          disabled={!retries}
          onPress={() => composer.current?.send()}
        >
          <Text
            style={{
              fontFamily: font.sans,
              fontSize: 13,
              lineHeight: 18,
              color: color.muted,
              textAlign: "center",
            }}
          >
            {said.text}
          </Text>
        </Pressable>
      )}
    </Sheet>
  );
}

/** One quiet centred line in the sheet. */
function Quiet({ children, testID }: { children: string | null; testID: string }) {
  const { color } = useTheme();
  return (
    <Text
      testID={testID}
      style={{
        fontFamily: font.sans,
        fontSize: 14,
        lineHeight: 20,
        color: color.muted,
        textAlign: "center",
        paddingVertical: 8,
      }}
    >
      {children}
    </Text>
  );
}

/** The thread's foot: the turning slice and what the agent is doing, or why the canvas waits. */
function Foot({ foot }: { foot: ChatFoot }) {
  const { color } = useTheme();
  if (foot.kind === "working") {
    return (
      <View
        testID="chat-working"
        accessible
        accessibilityRole="text"
        accessibilityLabel={foot.text}
        accessibilityLiveRegion="polite"
        style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 14 }}
      >
        <Juice size={16} color={color.ink} />
        <Text
          numberOfLines={1}
          style={{ flex: 1, fontFamily: font.sans, fontSize: 14, color: color.muted }}
        >
          {foot.text}
        </Text>
      </View>
    );
  }
  return (
    <View
      testID="chat-waiting"
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingTop: 14 }}
    >
      {foot.failed ? <AlertCircle size={15} color={color.danger} /> : null}
      <Text
        style={{ flex: 1, fontFamily: font.sans, fontSize: 14, lineHeight: 20, color: color.muted }}
      >
        {foot.text}
      </Text>
    </View>
  );
}

/** One line of the thread. Memoized: text streaming into the newest line redraws it alone. */
const ChatLine = memo(function ChatLine({
  row,
  meId,
  onOpenComment,
  onOpenLink,
  onOpenPullRequest,
}: {
  row: ThreadRow;
  meId: string;
  onOpenComment: (threadId: string) => void;
  onOpenLink: (url: string) => void;
  onOpenPullRequest: () => void;
}) {
  const { item } = row;
  switch (item.kind) {
    case "message":
    case "comment":
      return <PersonLine row={row} item={item} meId={meId} onOpenComment={onOpenComment} />;
    case "assistant":
      return (
        <View
          testID={row.aside ? "chat-aside" : "chat-reply"}
          style={row.asideContinues ? { marginTop: -8 } : null}
        >
          <Markdown
            text={item.payload.text}
            streaming={item.streaming}
            quiet={Boolean(row.aside)}
            onOpenLink={onOpenLink}
          />
        </View>
      );
    case "tool":
      // The agent's work is never a line: while a turn runs it is the foot's working line.
      return null;
    case "notice":
      return <NoticeLine notice={item.payload} meId={meId} onOpenPullRequest={onOpenPullRequest} />;
  }
});

/** Where a comment was left, in words: its board, or the canvas (and its page). */
function placeOf(comment: Extract<ThreadItem, { kind: "comment" }>["payload"]): string {
  if (comment.artboardName) return comment.artboardName;
  if (comment.artboardId) return "a board";
  return comment.pageName ? `the canvas, ${comment.pageName}` : "the canvas";
}

/**
 * A person's message, or their comment from the canvas: a bubble on the right. A message's
 * pictures sit above it; a comment's picture of where it was left sits above its words, and goes
 * there when pressed, or without a picture a quiet line says where. In a team's thread, the
 * sender's avatar is stamped on the last bubble of their run.
 */
function PersonLine({
  row,
  item,
  meId,
  onOpenComment,
}: {
  row: ThreadRow;
  item: Extract<ThreadItem, { kind: "message" | "comment" }>;
  meId: string;
  onOpenComment: (threadId: string) => void;
}) {
  const { color, scheme } = useTheme();
  const { from, text } = item.payload;
  const sending = item.kind === "message" && item.payload.delivery === "sending";
  const comment = item.kind === "comment" ? item.payload : null;
  const [broken, setBroken] = useState(false);
  const picture = comment?.picture?.kind === "image" && !broken ? comment.picture : null;
  return (
    <View
      testID={item.kind === "comment" ? "chat-comment" : "chat-message"}
      style={{
        alignSelf: "flex-end",
        alignItems: "flex-end",
        gap: picture ? 2 : 5,
        maxWidth: "82%",
        marginTop: row.continues ? -8 : 0,
        marginRight: row.team ? 8 : 0,
      }}
    >
      {item.kind === "message" && item.payload.attachments.length > 0 && (
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}
        >
          {item.payload.attachments.map((a) => (
            <Image
              key={a.ref}
              source={{ uri: a.url }}
              accessibilityIgnoresInvertColors
              style={
                item.payload.attachments.length === 1
                  ? { height: 160, width: 160, borderRadius: 10 }
                  : { height: 88, width: 88, borderRadius: 10 }
              }
              contentFit="cover"
            />
          ))}
        </View>
      )}
      {comment && (
        <Pressable
          // VoiceOver reads the press, not the picture in it: the id says which it shows.
          testID={picture ? "chat-comment-picture" : "chat-comment-open"}
          accessibilityRole="button"
          accessibilityLabel={CHAT.openComment(placeOf(comment))}
          onPress={() => {
            tick();
            onOpenComment(comment.threadId);
          }}
        >
          {picture ? (
            <Image
              source={{ uri: scheme === "dark" ? picture.dark : picture.light }}
              accessibilityIgnoresInvertColors
              onError={() => setBroken(true)}
              style={{
                ...pictureSize(picture.width, picture.height),
                borderRadius: 10,
                borderBottomRightRadius: 5,
                backgroundColor: color.canvas,
              }}
              contentFit="cover"
            />
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: brand.yuzu }} />
              <Text
                numberOfLines={1}
                style={{ fontFamily: font.sans, fontSize: 12, color: color.faint }}
              >
                On {placeOf(comment)}
              </Text>
            </View>
          )}
        </Pressable>
      )}
      <View>
        <Text
          accessibilityLabel={`${who(from, meId)}${item.kind === "comment" ? " commented" : " said"}: ${text}`}
          selectable
          style={{
            fontFamily: font.sans,
            fontSize: 16,
            lineHeight: 22,
            color: color.ink,
            backgroundColor: color.chip,
            borderRadius: 18,
            ...(picture ? { borderTopRightRadius: 5 } : {}),
            overflow: "hidden",
            paddingHorizontal: 13,
            paddingVertical: 8,
            opacity: sending ? 0.6 : 1,
          }}
        >
          {text}
        </Text>
        {row.avatar && <Stamp person={from} />}
      </View>
    </View>
  );
}

/** The sender's avatar on a bubble's corner, 20pt, ringed in the sheet's ground. */
function Stamp({ person }: { person: Person }) {
  const { color } = useTheme();
  const ring = {
    position: "absolute",
    right: -8,
    bottom: -7,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: color.card,
  } as const;
  return person.avatarUrl ? (
    <Image source={{ uri: person.avatarUrl }} accessibilityIgnoresInvertColors style={ring} />
  ) : (
    <View
      style={[ring, { backgroundColor: color.ink, alignItems: "center", justifyContent: "center" }]}
    >
      <Text style={{ fontFamily: font.sans, fontWeight: "600", fontSize: 9, color: color.bg }}>
        {(person.name.trim()[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}

const PR_VERB = {
  draft: "opened as a draft",
  open: "opened",
  merged: "merged",
  closed: "closed",
} as const;
const AGENT_PR_VERB = {
  opened: "opened",
  ready: "marked ready",
  updated_branch: "updated the branch of",
  auto_merge: "turned on auto-merge for",
  merged: "merged",
} as const;

/**
 * What happened to the run that isn't anyone's words: quiet lines, an error in plain words. A
 * pull request's line opens the pull request sheet.
 */
function NoticeLine({
  notice,
  meId,
  onOpenPullRequest,
}: {
  notice: ThreadNotice;
  meId: string;
  onOpenPullRequest: () => void;
}) {
  const { color } = useTheme();
  const quiet = {
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 18,
    color: color.faint,
  } as const;
  const said = (words: string, testID = "chat-notice") => (
    <Text testID={testID} style={quiet}>
      {words}
    </Text>
  );
  const pullRequest = (words: string) => (
    <Pressable
      testID="chat-pull-request"
      accessibilityRole="button"
      accessibilityLabel={words}
      accessibilityHint={CHAT.openPullRequest}
      hitSlop={6}
      onPress={() => {
        tick();
        onOpenPullRequest();
      }}
    >
      <Text style={{ ...quiet, textDecorationLine: "underline" }}>{words}</Text>
    </Pressable>
  );
  switch (notice.type) {
    case "error":
      return (
        <View testID="chat-error" style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ marginTop: 2 }}>
            <AlertCircle size={15} color={color.danger} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontFamily: font.sans, fontSize: 15, lineHeight: 21, color: color.ink }}>
              {ERROR_COPY[notice.code]}
            </Text>
            {ERROR_DETAIL.has(notice.code) && notice.message ? (
              <Text numberOfLines={3} style={quiet}>
                {notice.message}
              </Text>
            ) : null}
          </View>
        </View>
      );
    case "stopped":
      return said(notice.by ? `${who(notice.by, meId)} stopped it` : "Stopped", "chat-stopped");
    case "question":
      return said(`Asked: ${notice.text}${notice.answer ? ` → ${notice.answer}` : ""}`);
    case "pull_request":
      return pullRequest(
        `Pull request #${notice.number} ${PR_VERB[notice.state]}: ${notice.title}`,
      );
    case "pull_request_agent": {
      const as = notice.as ? (notice.as.id === meId ? "you" : who(notice.as, meId)) : null;
      return pullRequest(
        `Claude ${AGENT_PR_VERB[notice.action]} #${notice.number}${as ? ` as ${as}` : ""}: ${notice.title}`,
      );
    }
    case "owner_changed":
      return said(ownerChangedLine(notice.by, meId));
    case "driver":
      return said(driverNoticeLine(notice, meId));
    case "model_changed":
      return said(modelChangedLine(notice, meId));
    default:
      return null;
  }
}
