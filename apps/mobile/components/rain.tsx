import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  FadeIn,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { brand } from "../lib/tokens";

/**
 * Yuzu rain, as desktop's `Rain` (packages/react's working.tsx): columns of
 * dots falling at their own pace, saying "an agent is at work here". Sized
 * like desktop's em: `size` is the font size it would sit at, so a column is
 * 0.25 wide and 0.67 tall with 0.17 between columns. The columns come in left
 * to right.
 */
export function Rain({
  columns = 6,
  size = 19,
  color = brand.yuzu,
  label,
}: {
  columns?: number;
  size?: number;
  color?: string;
  /** Read out in its place; without one it's decoration. */
  label?: string;
}) {
  return (
    <View
      accessible={Boolean(label)}
      accessibilityRole={label ? "image" : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      style={{ flexDirection: "row", alignItems: "center", gap: 0.17 * size, height: size }}
    >
      {RAIN.slice(0, columns).map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed set of columns
        <Column key={i} index={i} fall={c.fall} start={c.start} size={size} color={color} />
      ))}
    </View>
  );
}

function Column({
  index,
  fall,
  start,
  size,
  color,
}: {
  index: number;
  fall: number;
  start: number;
  size: number;
  color: string;
}) {
  const p = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    p.value = 0;
    p.value = withRepeat(withTiming(1, { duration: fall * 1000, easing: Easing.linear }), -1);
    return () => cancelAnimation(p);
  }, [still, fall]);
  const d = 0.25 * size;
  return (
    <Animated.View
      entering={still ? undefined : FadeIn.duration(300).delay(index * 16)}
      style={{ width: d, height: 0.67 * size }}
    >
      {DOTS.map((y) => (
        <Dot
          key={y}
          y={y}
          p={p}
          start={start}
          d={d}
          top={(y * 0.67 - 0.125) * size}
          color={color}
        />
      ))}
    </Animated.View>
  );
}

function Dot({
  y,
  p,
  start,
  d,
  top,
  color,
}: {
  y: number;
  p: SharedValue<number>;
  start: number;
  d: number;
  top: number;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    // Desktop slides a mask three times the column's height from its bottom
    // third to its top third; this is the mask's alpha at the dot's middle.
    const at = (y + 2 * (1 - ((p.value + start) % 1))) / 3;
    return {
      opacity: interpolate(at, [0, 0.3, 0.45, 0.66], [0, 1, 0.6, 0], Extrapolation.CLAMP),
    };
  });
  return (
    <Animated.View
      style={[
        { position: "absolute", top, width: d, height: d, borderRadius: d, backgroundColor: color },
        style,
      ]}
    />
  );
}

/** Where each dot's middle sits, down the column: desktop's tiles of 0.42, in a column of 0.67. */
const DOTS = [0.125 / 0.67, 0.545 / 0.67];

/**
 * The rain's columns, as desktop's: each falls at its own pace from its own
 * start, the same every time. `start` is desktop's negative delay, as a
 * fraction of the fall.
 */
const RAIN = Array.from({ length: 24 }, (_, i) => {
  const r = (n: number) => (((Math.sin((i + 1) * n) * 43758.5453) % 1) + 1) % 1;
  const fall = Number((1.05 + r(12.9898) * 0.5).toFixed(2));
  const drift = Number((r(78.233) * 1.5).toFixed(2));
  return { fall, start: (drift % fall) / fall };
});
