import type { RailSignal } from "@ponzu/client/model";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { NEEDS_YOU, PR } from "../lib/copy";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";
import { brand, font } from "../lib/tokens";
import { BarButton } from "./chrome";
import { AgentMark, ChatIcon, CommentIcon, PullRequestIcon } from "./icons";

/**
 * The canvas's floating stack, bottom right, top to bottom (iPhone design §7): the pull request,
 * shown only once the canvas has one; Comment; and Chat, which shows what the Mac's thread toggle
 * shows (the shared `railSignal`): a needs-you count on its top-right edge while the agent waits
 * on someone, else the turning yuzu slice while it wakes or works, else its own mark.
 *
 * Chat opens the chat sheet (components/chat-sheet.tsx), and the pull request its own
 * (components/pr-sheet.tsx). The questions the count stands for are answered in the chat's
 * composer slot (needs-you.tsx).
 * Comment on a canvas the person may only look at is shown and said to be unavailable, not
 * hidden, so the stack never jumps.
 *
 * While the person's own agent drives the canvas (`driver`, docs/cloud.md "Your own agent"),
 * Chat is that agent's mark and doesn't open the chat: a tap or a long press says who drives it,
 * with Take back (`onDriver`), as the Mac's thread toggle does.
 */
export function CanvasStack({
  bottom,
  right,
  prNumber,
  chat,
  onPullRequest,
  onComment,
  onChat,
  commenting = false,
  commentHint = null,
  driver = null,
  onDriver,
}: {
  /** From the screen's bottom and right edges. */
  bottom: number;
  right: number;
  prNumber: number | null;
  chat: RailSignal;
  onPullRequest?: () => void;
  onComment?: () => void;
  onChat: () => void;
  /** Comment was pressed and the pin isn't down yet: its glass is held. */
  commenting?: boolean;
  /** Why Comment is unavailable, for VoiceOver (the read-only line). */
  commentHint?: string | null;
  /** The person's own agent driving the canvas in place of Ponzu's: its mark, and its name. */
  driver?: { client: string; name: string } | null;
  /** Says who drives, with Take back (an alert). */
  onDriver?: () => void;
}) {
  const { color } = useTheme();
  const needsYou = driver ? 0 : typeof chat === "object" ? chat.needsYou : 0;
  const busy = !driver && chat === "working";
  const chatLabel =
    needsYou > 0 ? NEEDS_YOU.chat(needsYou) : busy ? "Chat, Ponzu is working" : "Chat";
  return (
    <View
      testID="canvas-stack"
      pointerEvents="box-none"
      style={{ position: "absolute", right, bottom, gap: 12, alignItems: "center", zIndex: 8 }}
    >
      {prNumber !== null && (
        <Control testID="stack-pr" label={PR.button(prNumber)} onPress={onPullRequest}>
          <PullRequestIcon color={color.ink} />
        </Control>
      )}
      <Control
        testID="stack-comment"
        label="Comment"
        onPress={onComment}
        held={commenting}
        hint={onComment ? undefined : (commentHint ?? undefined)}
      >
        <CommentIcon color={color.ink} />
      </Control>
      {driver ? (
        <Control
          testID="stack-chat-driver"
          label={`${driver.name} is driving this canvas`}
          onPress={onDriver ?? (() => {})}
          onLongPress={onDriver}
        >
          <AgentMark client={driver.client} size={20} color={color.ink} />
        </Control>
      ) : (
        <Control testID="stack-chat" label={chatLabel} onPress={onChat}>
          {busy ? (
            <View testID="stack-chat-working">
              <Juice size={20} color={color.ink} />
            </View>
          ) : (
            <ChatIcon color={color.ink} />
          )}
        </Control>
      )}
      {needsYou > 0 && (
        // On Chat's top-right edge. Its count is in Chat's own label for VoiceOver.
        <View
          testID="stack-chat-badge"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: "absolute",
            right: -4,
            bottom: 30,
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            paddingHorizontal: 5,
            backgroundColor: brand.yuzu,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            style={{ fontFamily: font.sans, fontWeight: "700", fontSize: 12, color: brand.ink }}
          >
            {needsYou > 99 ? "99+" : needsYou}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * One glass circle; without `onPress`, its mark faint and the button said to be unavailable.
 * Only the mark fades: glass under a faded view isn't drawn (components/glass.tsx).
 */
function Control({
  testID,
  label,
  onPress,
  onLongPress,
  held = false,
  hint,
  children,
}: {
  testID: string;
  label: string;
  onPress?: () => void;
  onLongPress?: () => void;
  held?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <BarButton
      testID={testID}
      label={label}
      hint={hint}
      held={held}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress}
    >
      <View style={{ opacity: onPress ? 1 : 0.4 }}>{children}</View>
    </BarButton>
  );
}
