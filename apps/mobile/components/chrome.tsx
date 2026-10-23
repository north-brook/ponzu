import type { ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { SliceMark } from "./icons";

/**
 * The floating 44pt controls over the canvas and on pushed screens: the
 * translucent bar color, the pop shadow and a half-point hairline (`--c-bar`,
 * `--c-pop`). The design blurs what's behind; that needs expo-blur, a native
 * module this build doesn't carry yet, and at 80% the bar reads the same.
 */
export function BarButton({
  onPress,
  children,
  label,
  ring = false,
  style,
}: {
  onPress?: () => void;
  children: ReactNode;
  label: string;
  /** The agent button while its card is open: a 1.5px ink ring. */
  ring?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}>
      <Bar
        style={[
          { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
          style ?? {},
        ]}
        ring={ring}
      >
        {children}
      </Bar>
    </Pressable>
  );
}

/** The bar's surface, for a button or the title pill. */
export function Bar({
  children,
  style,
  ring = false,
}: {
  children: ReactNode;
  style?: ViewStyle | ViewStyle[];
  ring?: boolean;
}) {
  const { color, shadow } = useTheme();
  return (
    <View
      style={[
        {
          borderRadius: 999,
          backgroundColor: color.bar,
          boxShadow: shadow.pop,
          borderWidth: ring ? 1.5 : 0.5,
          borderColor: ring ? color.ink : color.hairline,
        },
        ...(Array.isArray(style) ? style : [style]),
      ]}
    >
      {children}
    </View>
  );
}

/** The lockup: the slice and the wordmark, 24pt, as Designs' header draws it. */
export function Lockup({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <SliceMark size={28} color={color} />
      <Text
        style={{
          fontFamily: "Funnel Display",
          fontWeight: "700",
          fontSize: 24,
          lineHeight: 24,
          letterSpacing: -0.05 * 24,
          color,
          transform: [{ translateY: -1 }],
        }}
      >
        ponzu
      </Text>
    </View>
  );
}

/** The yuzu app tile, 64pt, that starts each Connect screen's marks. */
export function AppTile({
  size = 64,
  mark = 40,
  radius = 16,
}: {
  size?: number;
  mark?: number;
  radius?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: brand.yuzu,
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 0 0 1px rgba(17,17,16,0.08)",
      }}
    >
      <SliceMark size={mark} color={brand.ink} />
    </View>
  );
}
