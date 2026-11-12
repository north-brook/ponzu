import type { Author, Thread } from "@ponzu/core";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { shortAgo } from "../lib/ago";
import { draftKey } from "../lib/drafts";
import { useTheme } from "../lib/theme";
import { Composer, type Mode } from "./composer";
import { Glass } from "./glass";
import { AgentAvatar, Check } from "./icons";
import { Sheet } from "./sheet";

export interface ThreadProps {
  thread: Thread;
  /** The person, as their messages name them. */
  me: Pick<Author, "id" | "name">;
  /** The canvas it's in, by id: what an unsent reply is kept under (lib/drafts.ts). */
  file: string;
  onReply: (text: string, mode: Mode) => Promise<void>;
  onStatus: (status: Thread["status"]) => Promise<void>;
  /**
   * Why the person can't reply or resolve here (they may only look at the canvas, or it is the
   * last copy, offline): said in the reply field's place. Null when they can.
   */
  readOnly?: string | null;
  /** One line over the reply field: why a reply or a resolve didn't go, or that it waits. */
  note?: string | null;
}

/** The first letter of a name, for an avatar. */
export const initialOf = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

/** Whether a message is the person's own. */
export const isMine = (author: Author, me: Pick<Author, "id" | "name">) =>
  author.kind === "user" && (author.id ? author.id === me.id : author.name === me.name);

/**
 * A thread (Flow › 11 Thread): a 450pt sheet over the canvas with the pin in
 * view above it. The message count and Resolve (Reopen, once resolved), the
 * messages, and a reply field with the same voice ⇄ type button.
 */
export function ThreadSheet({
  onDismiss,
  onHeight,
  right,
  maxWidth,
  bottomBar,
  ...thread
}: ThreadProps & {
  onDismiss: () => void;
  onHeight: (px: number) => void;
  right?: number;
  maxWidth?: number;
  bottomBar?: number;
}) {
  return (
    <Sheet
      testID="thread-sheet"
      onDismiss={onDismiss}
      onHeight={onHeight}
      height={450}
      gap={16}
      right={right}
      maxWidth={maxWidth}
      bottomBar={bottomBar}
    >
      <ThreadView {...thread} />
    </Sheet>
  );
}

/**
 * A thread's body, wherever it shows: in its sheet, or in the comments
 * panel or half on iPhone Duo (components/comments.tsx), under that
 * surface's own header.
 */
export function ThreadView({
  thread,
  file,
  onReply,
  onStatus,
  readOnly = null,
  note = null,
}: ThreadProps) {
  const { color } = useTheme();
  // The reply field shows first, unfocused (the design's 11); the mic switches to voice.
  const [mode, setMode] = useState<Mode>("type");
  const [busy, setBusy] = useState(false);
  const n = thread.messages.length;
  const resolved = thread.status === "resolved";
  const toggle = async () => {
    setBusy(true);
    try {
      await onStatus(resolved ? "open" : "resolved");
    } catch {
      // The screen says why (`note`).
    } finally {
      setBusy(false);
    }
  };
  const locked = Boolean(readOnly);
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text
          style={{
            flex: 1,
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 15,
            color: color.muted,
          }}
        >
          {n === 1 ? "1 message" : `${n} messages`}
          {resolved ? " · Resolved" : ""}
        </Text>
        {/* Glass, as the other floating controls; held a step darker while pressed. */}
        <Pressable
          onPress={toggle}
          disabled={busy || locked}
          accessibilityRole="button"
          accessibilityLabel={resolved ? "Reopen" : "Resolve"}
          accessibilityState={{ disabled: busy || locked }}
          testID="resolve"
        >
          {({ pressed }) => (
            // Held while pressed or while it's being sent; never dimmed, as glass under a dimmed view isn't drawn.
            <Glass
              interactive
              held={pressed || busy}
              style={{
                height: 36,
                paddingLeft: 10,
                paddingRight: 14,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Check size={17} color={locked ? color.faint : color.ink} />
              <Text
                style={{
                  fontFamily: "Inter",
                  fontWeight: "600",
                  fontSize: 14,
                  color: locked ? color.faint : color.ink,
                }}
              >
                {resolved ? "Reopen" : "Resolve"}
              </Text>
            </Glass>
          )}
        </Pressable>
      </View>
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ gap: 18 }}
        keyboardDismissMode="interactive"
      >
        {thread.messages.map((m) => {
          const agent = m.author.kind === "agent";
          return (
            <View key={m.id} style={{ flexDirection: "row", gap: 10 }}>
              {agent ? (
                <AgentAvatar
                  name={m.author.name}
                  client="claude"
                  color={color.ink}
                  soft={color.pinSoft}
                />
              ) : (
                <Initial letter={initialOf(m.author.name)} />
              )}
              <View style={{ flex: 1, gap: 3 }}>
                <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
                  <Text
                    style={{
                      fontFamily: "Inter",
                      fontWeight: "600",
                      fontSize: 14,
                      lineHeight: 18.2,
                      color: color.ink,
                    }}
                  >
                    {m.author.name}
                  </Text>
                  <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.faint }}>
                    {shortAgo(m.createdAt)}
                  </Text>
                </View>
                <Text
                  style={{ fontFamily: "Inter", fontSize: 16, lineHeight: 24, color: color.ink }}
                >
                  {m.text}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
      {note && !locked && <Line testID="thread-note">{note}</Line>}
      {locked ? (
        <Line testID="thread-read-only">{readOnly}</Line>
      ) : (
        <Composer
          mode={mode}
          onMode={setMode}
          placeholder={resolved ? "Reply to reopen" : "Reply"}
          onSend={onReply}
          autoFocus={false}
          draft={{ key: draftKey.reply(file, thread.id), file, thread: thread.id }}
        />
      )}
    </>
  );
}

/** One quiet line in the sheet. */
function Line({ children, testID }: { children: ReactNode; testID: string }) {
  const { color } = useTheme();
  return (
    <Text
      testID={testID}
      style={{
        fontFamily: "Inter",
        fontSize: 14,
        lineHeight: 19.6,
        color: color.muted,
        textAlign: "center",
      }}
    >
      {children}
    </Text>
  );
}

/** The person's avatar: their initial on ink, 28pt. */
export function Initial({ letter, children }: { letter: string; children?: ReactNode }) {
  const { color } = useTheme();
  return (
    <View
      style={{
        width: 28,
        height: 28,
        borderRadius: 999,
        backgroundColor: color.ink,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 12, color: color.bg }}>
        {letter}
      </Text>
      {children}
    </View>
  );
}
