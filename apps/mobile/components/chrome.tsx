import type { ReactNode } from "react";
import { Pressable, Text, View, type ViewStyle } from "react-native";
import { brand } from "../lib/tokens";
import { Glass } from "./glass";
import { HandoffTarget, HandoffWord } from "./handoff";
import { SliceMark } from "./icons";

/**
 * A floating 44pt control over the canvas and on pushed screens (back, the
 * agent's mark, the bell): a circle of interactive Liquid Glass, or the bar's
 * surface before iOS 26 (see glass.tsx).
 */
export function BarButton({
  onPress,
  children,
  label,
  ring = false,
  style,
  testID,
}: {
  onPress?: () => void;
  children: ReactNode;
  label: string;
  /** The agent button while its card is open: a 1.5pt ink ring. */
  ring?: boolean;
  style?: ViewStyle;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      testID={testID}
    >
      <Glass
        interactive
        ring={ring}
        style={[{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }, style]}
      >
        {children}
      </Glass>
    </Pressable>
  );
}

/**
 * The lockup: the slice and the wordmark, 24pt, as Designs' header draws
 * it. Coming from the launch screen, its slice is where the launch's slice
 * lands, and the word slides in after it (components/handoff.tsx).
 */
export function Lockup({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <HandoffTarget kind="designs" size={28}>
        <SliceMark size={28} color={color} />
      </HandoffTarget>
      <HandoffWord>
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
      </HandoffWord>
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
