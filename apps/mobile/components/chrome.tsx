import { type ReactNode, useRef } from "react";
import { type HostInstance, Pressable, Text, View, type ViewStyle } from "react-native";
import { BAR_ITEM_INSET, measureMargin } from "../lib/margin";
import { LOCKUP_MARK_LIFT } from "../lib/mark";
import { Juice } from "../lib/slice";
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
  held = false,
  shown = true,
  style,
  testID,
}: {
  onPress?: () => void;
  children: ReactNode;
  label: string;
  /** Held open: the glass a step darker. */
  held?: boolean;
  /** The glass is there; false dissolves it (components/glass.tsx). */
  shown?: boolean;
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
        held={held}
        shown={shown}
        style={[{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }, style]}
      >
        {children}
      </Glass>
    </Pressable>
  );
}

/**
 * The lockup: the slice and the wordmark, 24pt, as Designs' header draws
 * it, the slice centered on the word's x-height. `busy` (Macs still being
 * asked) juices the slice where it is: the app's one loading signal. Coming from the launch
 * screen, its slice is where the launch's slice lands (measured where it
 * is, lift and all), and the word slides in after it (components/handoff.tsx).
 */
export function Lockup({ color, busy = false }: { color: string; busy?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {/* A layout offset, not a transform: the handoff measures the place it lands on. */}
      <View style={{ top: -LOCKUP_MARK_LIFT }}>
        <HandoffTarget kind="designs" size={28}>
          {/* Still looking for Macs: the slice juices in its own box; nothing moves. */}
          {busy ? <Juice size={28} color={color} /> : <SliceMark size={28} color={color} />}
        </HandoffTarget>
      </View>
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

/**
 * A tab's title in the header's row, where Designs has its lockup: Funnel
 * Display bold, 26pt, so Search and Activity read as Designs does.
 */
export function HeaderTitle({ children, color }: { children: string; color: string }) {
  const ref = useRef<HostInstance>(null);
  return (
    <Text
      ref={ref}
      // Where the header puts it is the margin (lib/margin.ts).
      onLayout={() => ref.current?.measureInWindow((x) => measureMargin(x + BAR_ITEM_INSET))}
      accessibilityRole="header"
      style={{
        // The bar puts its view 4pt inside the margin: the title's letters sit on it.
        marginLeft: -BAR_ITEM_INSET,
        fontFamily: "Funnel Display",
        fontWeight: "700",
        fontSize: 26,
        lineHeight: 28,
        letterSpacing: -0.03 * 26,
        color,
      }}
    >
      {children}
    </Text>
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
