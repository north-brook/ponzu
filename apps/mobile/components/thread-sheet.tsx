import type { Thread } from "@ponzu/core";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { clientOf, shortAgent } from "../lib/activity";
import { shortAgo } from "../lib/files";
import { useTheme } from "../lib/theme";
import { Composer, type Mode } from "./composer";
import { Glass } from "./glass";
import { AgentAvatar, Check } from "./icons";
import { Sheet } from "./sheet";

/**
 * A thread (Flow › 11 Thread): a 450pt sheet over the canvas with the pin in
 * view above it. The message count and Resolve (Reopen, once resolved), the
 * messages, and a reply field with the same voice ⇄ type button.
 */
export function ThreadSheet({
  thread,
  me,
  onReply,
  onStatus,
  onDismiss,
  onHeight,
}: {
  thread: Thread;
  /** The person's initial, for their avatar. */
  me: string;
  onReply: (text: string, mode: Mode) => Promise<void>;
  onStatus: (status: Thread["status"]) => Promise<void>;
  onDismiss: () => void;
  onHeight: (px: number) => void;
}) {
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
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet testID="thread-sheet" onDismiss={onDismiss} onHeight={onHeight} height={450} gap={16}>
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
        <Pressable onPress={toggle} disabled={busy} accessibilityRole="button" testID="resolve">
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
              <Check size={17} color={color.ink} />
              <Text
                style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 14, color: color.ink }}
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
                  client={clientOf(m.author.name)}
                  color={color.ink}
                  soft={color.pinSoft}
                />
              ) : (
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
                  <Text
                    style={{
                      fontFamily: "Inter",
                      fontWeight: "600",
                      fontSize: 12,
                      color: color.bg,
                    }}
                  >
                    {me}
                  </Text>
                </View>
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
                    {agent ? shortAgent(m.author.name) : "You"}
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
      <Composer
        mode={mode}
        onMode={setMode}
        placeholder="Reply"
        onSend={onReply}
        autoFocus={false}
      />
    </Sheet>
  );
}
