import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../lib/theme";
import { CommentIcon, Move, Trash } from "./icons";
import { Sheet } from "./sheet";

/** iOS's system red, for what takes something away. */
const RED = { light: "#ff3b30", dark: "#ff453a" } as const;

/**
 * An unsent comment's pin, held: the start of its words, and Open, Move and Discard draft, as
 * desktop's right-click on it. A small floating sheet, not the system's menu: iOS can't open one
 * on a pin the canvas's web view draws. Swipe down to leave it be.
 */
export function DraftSheet({
  text,
  onOpen,
  onMove,
  onDiscard,
  onDismiss,
  right,
  maxWidth,
  bottomBar,
}: {
  text: string;
  onOpen: () => void;
  onMove: () => void;
  onDiscard: () => void;
  onDismiss: () => void;
  right?: number;
  maxWidth?: number;
  bottomBar?: number;
}) {
  const { color, scheme } = useTheme();
  return (
    <Sheet
      testID="draft-sheet"
      onDismiss={onDismiss}
      gap={6}
      right={right}
      maxWidth={maxWidth}
      bottomBar={bottomBar}
    >
      <View
        style={{
          gap: 4,
          paddingTop: 6,
          paddingBottom: 12,
          paddingHorizontal: 10,
          borderBottomWidth: 1,
          borderBottomColor: color.hairline,
        }}
      >
        <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.muted }}>
          Unsent comment
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: "Inter", fontSize: 16, color: color.ink }}>
          {text}
        </Text>
      </View>
      <Row label="Open" icon={<CommentIcon color={color.ink} />} onPress={onOpen} />
      <Row label="Move" icon={<Move color={color.ink} />} onPress={onMove} />
      <Row
        label="Discard draft"
        icon={<Trash color={RED[scheme]} />}
        color={RED[scheme]}
        onPress={onDiscard}
      />
    </Sheet>
  );
}

function Row({
  label,
  icon,
  color: tint,
  onPress,
}: {
  label: string;
  icon: ReactNode;
  color?: string;
  onPress: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`draft-${label.split(" ")[0]!.toLowerCase()}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        height: 48,
        paddingHorizontal: 10,
        borderRadius: 14,
        backgroundColor: pressed ? color.chip : "transparent",
      })}
    >
      {icon}
      <Text
        style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 16, color: tint ?? color.ink }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
