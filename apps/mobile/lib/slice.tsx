import { useEffect, useState } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { SLICE, SLICE_STROKE } from "./mark";
import { brand, EASE_OUT } from "./tokens";

/**
 * The brand's bloom (design/brand.design, motion 04): each segment grows
 * from nothing and turns from -60° into place, 50ms after the one before,
 * over 700ms on the house ease-out. The loop holds the slice whole, then
 * lets each segment go the same way, turning on to +60°, as the iPhone
 * design's launch screen does while it looks for a Mac.
 */
export const BLOOM = {
  duration: 700,
  stagger: 50,
  turn: 60,
  /** The loop's hold with the slice whole, and its pause with it gone. */
  hold: 1470,
  gone: 330,
} as const;
const ease = Easing.bezier(...EASE_OUT);

/**
 * How a segment stands: 0 not yet bloomed (no size, turned -60°), 1 whole,
 * 2 gone (no size, turned +60°).
 */
type Phase = number;
const HIDDEN: Phase = 0;
const WHOLE: Phase = 1;
const GONE: Phase = 2;

export type Bloom =
  /** Whole, still. */
  | false
  /** Blooms in once. */
  | "in"
  /**
   * Starts whole (where the native splash leaves it), holds, then goes and
   * blooms back, for as long as it shows.
   */
  | "loop"
  /**
   * Blooms in from nothing, then loops as "loop" does: the launch screen,
   * over a native splash that's yuzu alone (Connect › 1 Launch, `bloomin`).
   */
  | "inThenLoop";

/** How long a bloom-in takes to land, every segment whole: the last starts 5 staggers in. */
export const BLOOM_IN_MS = BLOOM.duration + (6 - 1) * BLOOM.stagger;

/**
 * The Ponzu mark. Each segment is its own 64-unit layer, so it scales and
 * turns about the slice's centre. Reduce Motion shows the slice whole.
 */
export function Slice({
  size = 64,
  color = brand.ink,
  bloom = false,
  delay = 0,
  style,
}: {
  size?: number;
  color?: string;
  bloom?: Bloom;
  /** Before the first segment moves, in ms. */
  delay?: number;
  style?: ViewStyle;
}) {
  const still = useReducedMotion();
  return (
    <View style={[{ width: size, height: size }, style]} accessibilityLabel="Ponzu" accessible>
      {SLICE.map((d, i) => (
        <Segment
          key={d}
          d={d}
          size={size}
          color={color}
          bloom={still ? false : bloom}
          delay={delay + i * BLOOM.stagger}
        />
      ))}
    </View>
  );
}

function Segment({
  d,
  size,
  color,
  bloom,
  delay,
}: {
  d: string;
  size: number;
  color: string;
  bloom: Bloom;
  delay: number;
}) {
  const phase = useSharedValue<Phase>(bloom === "in" || bloom === "inThenLoop" ? HIDDEN : WHOLE);
  useEffect(() => {
    if (bloom === "in") {
      phase.value = HIDDEN;
      phase.value = withDelay(delay, withTiming(WHOLE, { duration: BLOOM.duration, easing: ease }));
    } else if (bloom === "loop" || bloom === "inThenLoop") {
      const from = bloom === "inThenLoop";
      phase.value = from ? HIDDEN : WHOLE;
      // The stagger sits outside the repeat, so every segment keeps one period.
      const loop = withRepeat(
        withSequence(
          withTiming(WHOLE, { duration: BLOOM.hold }),
          withTiming(GONE, { duration: BLOOM.duration, easing: ease }),
          withTiming(GONE, { duration: BLOOM.gone }),
          withTiming(HIDDEN, { duration: 0 }),
          withTiming(WHOLE, { duration: BLOOM.duration, easing: ease }),
        ),
        -1,
      );
      phase.value = withDelay(
        delay,
        from
          ? withSequence(withTiming(WHOLE, { duration: BLOOM.duration, easing: ease }), loop)
          : loop,
      );
    } else {
      phase.value = WHOLE;
    }
    return () => cancelAnimation(phase);
  }, [bloom, delay]);
  const style = useBloomStyle(phase);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <Path d={d} fill={color} stroke={color} strokeWidth={SLICE_STROKE} strokeLinejoin="round" />
      </Svg>
    </Animated.View>
  );
}

function useBloomStyle(phase: SharedValue<Phase>) {
  return useAnimatedStyle(() => ({
    transform: [
      { rotate: `${(phase.value - WHOLE) * BLOOM.turn}deg` },
      { scale: 1 - Math.abs(phase.value - WHOLE) },
    ],
  }));
}

/** The slice's segments fading in turn: "still looking". Reduce Motion holds it whole. */
export function Juice({ size, color }: { size: number; color: string }) {
  const [i, setI] = useState(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    const t = setInterval(() => setI((n) => (n + 1) % 6), 200);
    return () => clearInterval(t);
  }, [still]);
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Loading">
      {SLICE.map((d, k) => (
        <Path
          key={d}
          d={d}
          fill={color}
          stroke={color}
          strokeWidth={SLICE_STROKE}
          strokeLinejoin="round"
          opacity={still ? 1 : (k - i + 6) % 6 < 3 ? 0.16 + ((k - i + 6) % 6) * 0.28 : 1}
        />
      ))}
    </Svg>
  );
}
