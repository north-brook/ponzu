import { Pressable, Text, View } from "react-native";
import { EMPTY_CANVASES, FILTER } from "../lib/copy";
import { select } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { PREVIEW, ROW_HEIGHT } from "./canvas-row";
import { Chevron } from "./icons";

/*
 * The canvases list's other states: rows still on their way, a workspace with nothing in it,
 * and the settled tray's header.
 */

/** One row's shape, at a row's metrics: the preview and its three lines. */
function RowShape({ margin, fill }: { margin: number; fill: string }) {
  const bar = (width: number | `${number}%`, height: number) => (
    <View style={{ width, height, borderRadius: height / 2, backgroundColor: fill }} />
  );
  return (
    <View
      style={{
        height: ROW_HEIGHT,
        paddingHorizontal: margin,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      }}
    >
      <View
        style={{
          width: PREVIEW.width,
          height: PREVIEW.height,
          borderRadius: PREVIEW.radius,
          borderCurve: "continuous",
          backgroundColor: fill,
        }}
      />
      <View style={{ flex: 1, gap: 7 }}>
        {bar(72, 9)}
        {bar("62%", 12)}
        {bar(96, 9)}
      </View>
    </View>
  );
}

/** While nothing has come yet: a few rows' shapes, in the chip colour. */
export function SkeletonRows({ margin }: { margin: number }) {
  const { color } = useTheme();
  return (
    <View testID="canvases-loading" accessibilityLabel="Loading canvases" accessible>
      {SKELETON.map((id) => (
        <RowShape key={id} margin={margin} fill={color.chip} />
      ))}
    </View>
  );
}

const SKELETON = ["a", "b", "c", "d"] as const;

/** A workspace with no canvases: a faint trace of the rows to come, and one quiet line. */
export function EmptyTrace({ margin }: { margin: number }) {
  const { color } = useTheme();
  return (
    <View testID="canvases-empty" accessible accessibilityLabel={EMPTY_CANVASES}>
      <View style={{ opacity: 0.5 }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ opacity: 1 - i * 0.3 }}>
            <RowShape margin={margin} fill={color.hairline} />
          </View>
        ))}
      </View>
      <Text
        style={{
          marginTop: 16,
          marginHorizontal: margin,
          fontFamily: "Inter",
          fontSize: 15,
          lineHeight: 22,
          color: color.faint,
        }}
      >
        {EMPTY_CANVASES}
      </Text>
    </View>
  );
}

/**
 * A filter that keeps nothing: the Mac sidebar's line, and Clear filter. Not the empty
 * workspace's trace: there are canvases, the filter hides them.
 */
export function FilteredEmpty({ margin, onClear }: { margin: number; onClear?: () => void }) {
  const { color } = useTheme();
  return (
    <View testID="canvases-filtered" style={{ marginHorizontal: margin, marginTop: 12, gap: 4 }}>
      <Text style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 22, color: color.muted }}>
        {FILTER.none}
      </Text>
      {onClear && (
        <Pressable
          testID="canvases-clear-filter"
          accessibilityRole="button"
          accessibilityLabel={FILTER.clear}
          onPress={() => {
            select();
            onClear();
          }}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            minHeight: 44,
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 15, color: color.ink }}>
            {FILTER.clear}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** The settled tray's header: "Settled", how many, and a chevron that turns when it is open. */
export function SettledHeader({
  count,
  open,
  margin,
  onToggle,
}: {
  count: number;
  open: boolean;
  margin: number;
  onToggle: (open: boolean) => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      testID="settled"
      accessibilityRole="button"
      accessibilityLabel={`Settled, ${count}`}
      accessibilityState={{ expanded: open }}
      onPress={() => {
        select();
        onToggle(!open);
      }}
      style={({ pressed }) => ({
        marginTop: 12,
        height: 44,
        paddingHorizontal: margin,
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        backgroundColor: pressed ? color.chip : undefined,
      })}
    >
      <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 14, color: color.muted }}>
        Settled
      </Text>
      <Text style={{ marginLeft: "auto", fontFamily: "Inter", fontSize: 13, color: color.faint }}>
        {count}
      </Text>
      <View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
        <Chevron color={color.faint} size={13} />
      </View>
    </Pressable>
  );
}
