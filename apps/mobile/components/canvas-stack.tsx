import type { RailSignal } from "@ponzu/client/model";
import type { ReactNode } from "react";
import { Alert, View } from "react-native";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";
import { BarButton } from "./chrome";
import { ChatIcon, CommentIcon, PullRequestIcon } from "./icons";

/**
 * The canvas's floating stack, bottom right, top to bottom (iPhone design §7): the pull request,
 * shown only once the canvas has one; Comment; and Chat, which shows what the Mac's thread toggle
 * shows (the shared `railSignal`): the turning yuzu slice while the agent wakes or works, else
 * its own mark.
 *
 * Chat opens the chat sheet (components/chat-sheet.tsx). The pull request has no sheet on the
 * iPhone yet, so until it does, pressing it says so in one alert instead of doing nothing. The
 * needs-you count isn't shown yet: the questions come to the chat's composer in their own slice.
 * Comment on a canvas the person may only look at is shown and said to be unavailable, not
 * hidden, so the stack never jumps.
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
}) {
  const { color } = useTheme();
  const busy = chat === "working";
  const chatLabel = busy ? "Chat, Ponzu is working" : "Chat";
  return (
    <View
      testID="canvas-stack"
      pointerEvents="box-none"
      style={{ position: "absolute", right, bottom, gap: 12, alignItems: "center", zIndex: 8 }}
    >
      {prNumber !== null && (
        <Control
          testID="stack-pr"
          label={`Pull request #${prNumber}`}
          onPress={onPullRequest ?? (() => Alert.alert(NOT_YET.pullRequest))}
        >
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
      <Control testID="stack-chat" label={chatLabel} onPress={onChat}>
        {busy ? (
          <View testID="stack-chat-working">
            <Juice size={20} color={color.ink} />
          </View>
        ) : (
          <ChatIcon color={color.ink} />
        )}
      </Control>
    </View>
  );
}

/** What the pull request says when pressed, until its sheet comes to the iPhone. */
export const NOT_YET = {
  pullRequest: "Pull requests aren't on the iPhone yet. They come in the next update.",
} as const;

/**
 * One glass circle; without `onPress`, its mark faint and the button said to be unavailable.
 * Only the mark fades: glass under a faded view isn't drawn (components/glass.tsx).
 */
function Control({
  testID,
  label,
  onPress,
  held = false,
  hint,
  children,
}: {
  testID: string;
  label: string;
  onPress?: () => void;
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
      disabled={!onPress}
    >
      <View style={{ opacity: onPress ? 1 : 0.4 }}>{children}</View>
    </BarButton>
  );
}
