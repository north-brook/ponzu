import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { pullRequestIcon, type RowIndicator } from "@ponzu/client/model";
import { Image } from "expo-image";
import { memo } from "react";
import { ActionSheetIOS, Pressable, Text, View } from "react-native";
import { indicatorOf, type ListRow, previewUri, rowLabel } from "../lib/cloud/list";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { Branch, Folder, Repo } from "./icons";

/** The preview's size beside the three lines, as the Mac sidebar's. */
export const PREVIEW = { width: 64, height: 48, radius: 6 } as const;
/** A row's height: the preview and its padding. */
export const ROW_HEIGHT = PREVIEW.height + 2 * 10;

const PULL_REQUEST_ICONS = {
  open: GitPullRequestIcon,
  draft: GitPullRequestIcon,
  conflict: GitPullRequestClosedIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
} as const;

export type RowAction = "settle" | "reopen";

/**
 * A canvas in the list, as the Mac sidebar draws it (components/canvas-row.tsx is the one place
 * to change it): its preview beside three lines. The first says where it lives (the repo, or
 * Scratch) with its one status at the end; the second is its name; the third its branch (or
 * Scratch's place) with its pull request at the end. While it waits on the viewer, the third line
 * is the question it waits on. A press opens it; holding it offers Settle, or Reopen in the tray,
 * in the system's action sheet.
 * It draws again only when its own row changes.
 */
export const CanvasRow = memo(function CanvasRow({
  row,
  margin,
  onOpen,
  onAction,
}: {
  row: ListRow;
  margin: number;
  onOpen: (canvasId: string) => void;
  onAction: (row: ListRow, action: RowAction) => void;
}) {
  const { color, scheme } = useTheme();
  const { canvas, question } = row;
  const indicator = indicatorOf(canvas);
  const settled = canvas.status === "settled";
  const preview = previewUri(canvas.preview, scheme);
  const pr = canvas.pullRequest;
  const { project } = canvas;
  const meta = { fontFamily: "Inter", fontSize: 12, lineHeight: 15, color: color.muted } as const;
  const action: RowAction = settled ? "reopen" : "settle";
  const actionTitle = settled ? "Reopen" : "Settle";
  // Holding offers the one action in the system's action sheet. Not @react-native-menu's
  // MenuView around the row: on iOS its context menu interaction kept every short tap from the
  // row (on spare's simulator the row never opened), so a press could not open the canvas.
  const hold = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      { title: canvas.name, options: [actionTitle, "Cancel"], cancelButtonIndex: 1 },
      (index) => {
        if (index === 0) onAction(row, action);
      },
    );
  return (
    <Pressable
      testID={`canvas-${canvas.id}`}
      accessibilityRole="button"
      accessibilityLabel={rowLabel(canvas, indicator, question)}
      accessibilityHint={settled ? "Hold to reopen it" : "Hold to settle it"}
      accessibilityActions={[
        { name: settled ? "reopen" : "settle", label: settled ? "Reopen" : "Settle" },
      ]}
      onAccessibilityAction={(e) => {
        const name = e.nativeEvent.actionName;
        if (name === "settle" || name === "reopen") onAction(row, name);
      }}
      onPress={() => onOpen(canvas.id)}
      // With a long press of its own, letting go after one never also opens the canvas.
      onLongPress={hold}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        height: ROW_HEIGHT,
        paddingHorizontal: margin,
        backgroundColor: pressed ? color.chip : undefined,
      })}
    >
      <View
        style={{
          width: PREVIEW.width,
          height: PREVIEW.height,
          borderRadius: PREVIEW.radius,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: color.chip,
        }}
      >
        {preview && (
          <Image
            testID={`canvas-${canvas.id}-preview`}
            source={{ uri: preview }}
            cachePolicy="disk"
            contentFit="cover"
            contentPosition="top"
            transition={150}
            recyclingKey={canvas.id}
            accessibilityIgnoresInvertColors
            style={{ width: PREVIEW.width, height: PREVIEW.height }}
          />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 15 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
            {project.kind === "repo" ? (
              <Repo color={color.muted} size={12} />
            ) : (
              <Folder color={color.muted} size={12} />
            )}
            <Text numberOfLines={1} style={meta}>
              {project.kind === "repo" ? project.repo.name : "Scratch"}
            </Text>
          </View>
          {indicator && <IndicatorMark indicator={indicator} id={canvas.id} />}
        </View>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 16,
            lineHeight: 20,
            color: color.ink,
          }}
        >
          {canvas.name}
        </Text>
        {question ? (
          <Text
            testID={`canvas-${canvas.id}-question`}
            numberOfLines={1}
            style={{ ...meta, color: color.ink }}
          >
            <Text style={{ fontWeight: "600" }}>{question.header}</Text>
            {question.text ? `  ${question.text}` : ""}
          </Text>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 15 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 }}>
              {project.kind === "repo" && <Branch color={color.muted} size={12} />}
              <Text numberOfLines={1} style={meta}>
                {project.kind === "repo" ? project.branch : project.city}
              </Text>
            </View>
            {pr && (
              <View
                style={{
                  marginLeft: "auto",
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <HugeiconsIcon
                  icon={PULL_REQUEST_ICONS[pullRequestIcon(pr)]}
                  size={12}
                  color={color.muted}
                  strokeWidth={1.7}
                />
                <Text style={meta}>#{pr.number}</Text>
              </View>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
});

/** The one status mark, at the end of the row's first line, in yuzu. */
function IndicatorMark({ indicator, id }: { indicator: RowIndicator; id: string }) {
  if (indicator.kind === "needs_you") {
    return (
      <View
        testID={`canvas-${id}-needs-you`}
        style={{
          marginLeft: "auto",
          minWidth: 16,
          height: 16,
          paddingHorizontal: 4,
          borderRadius: 8,
          backgroundColor: brand.yuzu,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          style={{
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 10,
            lineHeight: 12,
            color: brand.ink,
          }}
        >
          {indicator.count}
        </Text>
      </View>
    );
  }
  if (indicator.kind === "working") {
    return (
      <View testID={`canvas-${id}-working`} style={{ marginLeft: "auto" }}>
        <Juice size={14} color={brand.yuzu} />
      </View>
    );
  }
  return (
    <View
      testID={`canvas-${id}-unseen`}
      style={{
        marginLeft: "auto",
        marginRight: 3,
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: brand.yuzu,
      }}
    />
  );
}
