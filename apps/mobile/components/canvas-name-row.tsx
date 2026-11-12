import type { CanvasListRow } from "@ponzu/client";
import { Pressable, Text, View } from "react-native";
import { openCanvas } from "../lib/canvas/open";
import { useTheme } from "../lib/theme";
import { Folder, Repo } from "./icons";

/**
 * A canvas in a plain list: its name, and its repo or Scratch; a press opens it. The list's own
 * row (preview, status and the shared indicator, components/canvas-row.tsx) replaces this with
 * the canvases list's slice, and opens the canvas the same way (`openCanvas`).
 */
export function CanvasNameRow({ canvas, margin }: { canvas: CanvasListRow; margin: number }) {
  const { color } = useTheme();
  const where = canvas.repoFullName ?? "Scratch";
  return (
    <Pressable
      testID={`canvas-${canvas.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${canvas.name}, ${where}`}
      onPress={() => openCanvas(canvas.id)}
      style={({ pressed }) => ({
        paddingHorizontal: margin,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: color.hairline,
        gap: 3,
        backgroundColor: pressed ? color.chip : undefined,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {canvas.repoFullName ? (
          <Repo color={color.muted} size={13} />
        ) : (
          <Folder color={color.muted} size={13} />
        )}
        <Text
          numberOfLines={1}
          style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18, color: color.muted }}
        >
          {where}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        style={{
          fontFamily: "Inter",
          fontWeight: "600",
          fontSize: 16,
          lineHeight: 21,
          color: color.ink,
        }}
      >
        {canvas.name}
      </Text>
    </Pressable>
  );
}
