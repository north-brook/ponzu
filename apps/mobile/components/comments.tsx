import { type Doc, findArtboard, type Thread } from "@ponzu/core";
import { Pressable, ScrollView, Text, View } from "react-native";
import { clientOf, shortAgent } from "../lib/activity";
import { shortAgo } from "../lib/files";
import { tick } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { Glass } from "./glass";
import { AgentMark, Back, Close, CommentIcon, PageIcon } from "./icons";
import { Initial, type ThreadProps, ThreadView } from "./thread-sheet";

/**
 * The page's open threads, newest first: what the comments surface lists,
 * and the count on its button. Only this page's, never the whole file's.
 */
export function openThreads(doc: Doc | null, pageId: string | undefined): Thread[] {
  if (!doc || !pageId) return [];
  return doc.threads
    .filter((t) => t.status === "open" && threadPageId(doc, t) === pageId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function threadPageId(doc: Doc, t: Thread): string | undefined {
  if (t.artboardId) return findArtboard(doc, t.artboardId)?.page.id;
  return t.pageId;
}

/**
 * The comments surface, the same in every pose (the Duo board's 3b, 6, 6b,
 * 8, 8b, 9, 9b): the list of this page's open threads, or one thread opened
 * from it or from its pin, with ← back to the list. It's the system's sheet
 * closed and upright (`components/sheet.tsx` holds it), an inset panel open
 * sideways, and half the display, always there, like a laptop or a book.
 * `onClose` puts the ×; where it's always there it has none.
 */
export function Comments({
  doc,
  pageId,
  thread,
  onOpen,
  onBack,
  onClose,
  seen,
  ...threadProps
}: {
  doc: Doc | null;
  pageId: string | undefined;
  /** The thread open in it, or null for the list. */
  thread: Thread | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  onClose?: () => void;
  /** When the person last looked at this design: a thread with something newer is unread. */
  seen: number;
} & Omit<ThreadProps, "thread">) {
  const { color } = useTheme();
  if (thread) {
    const board = thread.artboardId && doc ? findArtboard(doc, thread.artboardId) : null;
    return (
      <View testID="comments-thread" style={{ flex: 1, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Round label="Back to comments" onPress={onBack} testID="comments-back">
            <Back size={16} color={color.ink} width={1.9} />
          </Round>
          {board && <PageIcon name={board.page.icon} size={16} color={color.muted} />}
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontFamily: "Inter",
              fontWeight: "600",
              fontSize: 16,
              color: color.ink,
            }}
          >
            {board?.artboard.name ?? ""}
          </Text>
          {onClose && (
            <Round label="Close" onPress={onClose} testID="comments-close">
              <Close size={16} color={color.ink} width={1.9} />
            </Round>
          )}
        </View>
        <ThreadView key={thread.id} thread={thread} {...threadProps} />
      </View>
    );
  }
  const threads = openThreads(doc, pageId);
  return (
    <View testID="comments" style={{ flex: 1, gap: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36 }}>
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: 22,
            letterSpacing: -0.03 * 22,
            color: color.ink,
          }}
        >
          Comments
        </Text>
        <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 14, color: color.muted }}>
          {threads.length} open
        </Text>
        <View style={{ flex: 1 }} />
        {onClose && (
          <Round label="Close" onPress={onClose} testID="comments-close">
            <Close size={16} color={color.ink} width={1.9} />
          </Round>
        )}
      </View>
      <ScrollView style={{ flex: 1, minHeight: 0 }}>
        {threads.map((t, i) => (
          <Row
            key={t.id}
            doc={doc!}
            thread={t}
            me={threadProps.me}
            last={i === threads.length - 1}
            unread={unread(t, seen)}
            onPress={() => {
              tick();
              onOpen(t.id);
            }}
          />
        ))}
      </ScrollView>
      <Text
        style={{
          fontFamily: "Inter",
          fontSize: 13,
          lineHeight: 18.2,
          color: color.faint,
          textAlign: "center",
        }}
      >
        Hold on the canvas to add one
      </Text>
    </View>
  );
}

/** Something in the thread came after the person last looked, and it wasn't theirs. */
function unread(t: Thread, seen: number): boolean {
  const last = t.messages[t.messages.length - 1];
  return Boolean(last && last.author.kind !== "user" && last.createdAt > seen);
}

/**
 * One thread in the list (the board's rows): the author's avatar; the
 * board with its page's icon, when, and the unread dot; the first message,
 * two lines; the latest reply's author or "No replies yet", and the message
 * count, as desktop's pin shows it.
 */
function Row({
  doc,
  thread: t,
  me,
  last,
  unread,
  onPress,
}: {
  doc: Doc;
  thread: Thread;
  me: string;
  last: boolean;
  unread: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const first = t.messages[0];
  const author = first?.author;
  const latest = t.messages.length > 1 ? t.messages[t.messages.length - 1] : null;
  const board = t.artboardId ? findArtboard(doc, t.artboardId) : null;
  const small = {
    fontFamily: "Inter",
    fontWeight: "500",
    fontSize: 13,
    color: color.muted,
  } as const;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${board?.artboard.name ?? "Comment"}: ${first?.text ?? ""}`}
      testID={`comment-row-${t.id}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 12,
        paddingVertical: 14,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: color.hairline,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {author?.kind === "agent" ? (
        <AgentMark client={clientOf(author.name)} size={28} color={color.ink} />
      ) : (
        <Initial letter={me} />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 14, color: color.ink }}>
            {author?.kind === "agent" ? shortAgent(author.name) : "You"}
          </Text>
          {board && (
            <>
              <Text style={{ fontFamily: "Inter", fontSize: 14, color: color.faint }}>·</Text>
              <PageIcon name={board.page.icon} size={13} color={color.faint} width={1.5} />
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  fontFamily: "Inter",
                  fontWeight: "500",
                  fontSize: 14,
                  color: color.muted,
                }}
              >
                {board.artboard.name}
              </Text>
            </>
          )}
          {!board && <View style={{ flex: 1 }} />}
          <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.faint }}>
            {shortAgo(t.updatedAt)}
          </Text>
          {unread && (
            <View
              testID="comment-unread"
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                backgroundColor: brand.yuzu,
                boxShadow: "0 0 0 1px rgba(17,17,16,0.18)",
              }}
            />
          )}
        </View>
        <Text
          numberOfLines={2}
          style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 21, color: color.ink }}
        >
          {first?.text ?? ""}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {latest?.author.kind === "agent" && (
            <AgentMark client={clientOf(latest.author.name)} size={13} color={color.ink} />
          )}
          <Text style={small}>
            {latest
              ? `${latest.author.kind === "agent" ? shortAgent(latest.author.name) : "You"} replied`
              : "No replies yet"}
          </Text>
          <View style={{ flex: 1 }} />
          <CommentIcon size={13} color={color.faint} width={1.5} />
          <Text style={small}>{t.messages.length}</Text>
        </View>
      </View>
    </Pressable>
  );
}

/** A 36pt glass circle: the surface's ← and ×. */
function Round({
  label,
  onPress,
  testID,
  children,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={() => {
        tick();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      testID={testID}
    >
      <Glass
        interactive
        style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
      >
        {children}
      </Glass>
    </Pressable>
  );
}
