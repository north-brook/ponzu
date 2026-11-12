import type { CanvasListRow } from "@ponzu/client";
import { Text, View } from "react-native";
import { useTheme } from "../lib/theme";
import { Folder, Repo } from "./icons";

/**
 * A canvas in a plain list: its name, and its repo or Scratch. The list's own row (preview,
 * status and the shared indicator, components/canvas-row.tsx) replaces this with the canvases
 * list's slice; opening a canvas arrives with the canvas's.
 */
export function CanvasNameRow({ canvas, margin }: { canvas: CanvasListRow; margin: number }) {
  const { color } = useTheme();
  const where = canvas.repoFullName ?? "Scratch";
  return (
    <View
      testID={`canvas-${canvas.id}`}
      accessible
      accessibilityLabel={`${canvas.name}, ${where}`}
      style={{
        paddingHorizontal: margin,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: color.hairline,
        gap: 3,
      }}
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
    </View>
  );
}
