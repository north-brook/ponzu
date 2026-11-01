import { useEffect, useState } from "react";
import { type LayoutChangeEvent, Text, type TextStyle, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useSeen } from "../lib/use-seen";

/** Strips across the band, each a step of its fade. */
const SLICES = 12;

/**
 * A name an agent is working in, with desktop's shimmer: a soft band where
 * the text fades to 30%, sweeping across it every 1.8s. React Native has no
 * background-clip: text, and a band painted over the text shows on glass, so
 * the text itself fades: copies of it, each clipped to a strip of the band at
 * that strip's opacity, with whole-ink copies either side.
 */
export function Shimmer({ text, style, color }: { text: string; style: TextStyle; color: string }) {
  const x = useSharedValue(0);
  const still = useReducedMotion();
  const [w, setW] = useState(0);
  // Holds while nobody can see it: the app away, or its screen under another.
  const awake = useSeen();
  const moving = w > 0 && !still && awake;
  useEffect(() => {
    if (!moving) return;
    x.value = 0;
    x.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.linear }), -1);
    return () => cancelAnimation(x);
  }, [moving]);
  // desktop: a 200%-wide gradient, 40% ink, 50% faded, 60% ink, moved from 100% to -100%.
  // The band is 40% of the text wide; its left edge runs from -70% to 130%.
  const band = 0.4 * w;
  const at = useAnimatedStyle(() => ({ transform: [{ translateX: (x.value * 2 - 0.7) * w }] }));
  // Holds each copy still on the text while the band moves.
  const back = useAnimatedStyle(() => ({ transform: [{ translateX: -(x.value * 2 - 0.7) * w }] }));
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const strips = [
    { left: -2 * w, width: 2 * w, opacity: 1 },
    ...Array.from({ length: SLICES }, (_, i) => {
      const t = (i + 0.5) / SLICES;
      return {
        left: (i * band) / SLICES,
        width: band / SLICES,
        opacity: 1 - 0.7 * (1 - Math.abs(2 * t - 1)),
      };
    }),
    { left: band, width: 2 * w, opacity: 1 },
  ];
  return (
    <View style={{ flex: style.flex, minWidth: 0, overflow: "hidden" }} onLayout={onLayout}>
      {/* Sizes the name and reads it to VoiceOver; the copies draw it while it shimmers. */}
      <Text
        numberOfLines={1}
        style={[style, { flex: undefined, color: moving ? "transparent" : color }]}
      >
        {text}
      </Text>
      {moving && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[{ position: "absolute", top: 0, bottom: 0, left: 0, width: band }, at]}
        >
          {strips.map((s) => (
            <View
              key={s.left}
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: s.left,
                width: s.width,
                overflow: "hidden",
                opacity: s.opacity,
              }}
            >
              <Animated.View
                style={[{ position: "absolute", top: 0, left: -s.left, width: w }, back]}
              >
                <Text numberOfLines={1} style={[style, { flex: undefined, color }]}>
                  {text}
                </Text>
              </Animated.View>
            </View>
          ))}
        </Animated.View>
      )}
    </View>
  );
}
