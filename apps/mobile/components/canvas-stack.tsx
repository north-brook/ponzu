import type { RailSignal } from "@ponzu/client/model";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { BarButton } from "./chrome";
import { ChatIcon, CommentIcon, PullRequestIcon } from "./icons";

/**
 * The canvas's floating stack, bottom right, top to bottom (iPhone design §7): the pull request,
 * shown only once the canvas has one; Comment; and Chat, which shows what the Mac's thread toggle
 * shows (the shared `railSignal`): the needs-you count on its top-right edge, else the turning
 * yuzu slice while the agent wakes or works, else its own mark.
 *
 * A button with nowhere to go yet (the comment composer, the chat and pull request sheets come
 * with their own slices) is shown and said to be unavailable, not hidden, so the stack never
 * jumps when they arrive.
 */
export function CanvasStack({
  bottom,
  right,
  prNumber,
  chat,
  onPullRequest,
  onComment,
  onChat,
}: {
  /** From the screen's bottom and right edges. */
  bottom: number;
  right: number;
  prNumber: number | null;
  chat: RailSignal;
  onPullRequest?: () => void;
  onComment?: () => void;
  onChat?: () => void;
}) {
  const { color } = useTheme();
  const needsYou = typeof chat === "object" ? chat.needsYou : 0;
  const busy = chat === "working";
  const chatLabel =
    needsYou > 0
      ? `Chat, ${needsYou === 1 ? "Ponzu has a question" : `Ponzu has ${needsYou} questions`}`
      : busy
        ? "Chat, Ponzu is working"
        : "Chat";
  return (
    <View
      testID="canvas-stack"
      pointerEvents="box-none"
      style={{ position: "absolute", right, bottom, gap: 12, alignItems: "center", zIndex: 8 }}
    >
      {prNumber !== null && (
        <Control testID="stack-pr" label={`Pull request #${prNumber}`} onPress={onPullRequest}>
          <PullRequestIcon color={color.ink} />
        </Control>
      )}
      <Control testID="stack-comment" label="Comment" onPress={onComment}>
        <CommentIcon color={color.ink} />
      </Control>
      <Control testID="stack-chat" label={chatLabel} onPress={onChat}>
        {busy ? (
          <View testID="stack-chat-working">
            <Juice size={20} color={color.ink} />
          </View>
        ) : (
          <ChatIcon color={color.ink} />
        )}
      </Control>
      {needsYou > 0 && (
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
          <Text style={{ fontFamily: "Inter", fontWeight: "700", fontSize: 12, color: brand.ink }}>
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
  children,
}: {
  testID: string;
  label: string;
  onPress?: () => void;
  children: ReactNode;
}) {
  return (
    <BarButton testID={testID} label={label} onPress={onPress} disabled={!onPress}>
      <View style={{ opacity: onPress ? 1 : 0.4 }}>{children}</View>
    </BarButton>
  );
}
