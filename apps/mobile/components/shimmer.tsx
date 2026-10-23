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
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/**
 * A name an agent is working in, with desktop's shimmer: a soft band where
 * the text fades to 30%, sweeping across it every 1.8s. React Native has no
 * background-clip: text, so the band is the surface's own color at 70% over
 * the text, which reads the same on a plain background.
 */
export function Shimmer({
  text,
  style,
  color,
  surface,
}: {
  text: string;
  style: TextStyle;
  color: string;
  /** The color behind the text. */
  surface: string;
}) {
  const x = useSharedValue(0);
  const still = useReducedMotion();
  const [w, setW] = useState(0);
  useEffect(() => {
    if (still || !w) return;
    x.value = 0;
    x.value = withRepeat(withTiming(1, { duration: 1800, easing: Easing.linear }), -1);
    return () => cancelAnimation(x);
  }, [still, w]);
  // desktop: a 200%-wide gradient, 40% ink, 50% faded, 60% ink, moved from 100% to -100%.
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: (x.value * 2 - 1) * w }] }));
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  return (
    <View style={{ flex: style.flex, minWidth: 0, overflow: "hidden" }} onLayout={onLayout}>
      <Text numberOfLines={1} style={[style, { flex: undefined, color }]}>
        {text}
      </Text>
      {w > 0 && !still && (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", top: 0, bottom: 0, left: 0, width: w }, band]}
        >
          <Svg width={w} height="100%">
            <Defs>
              <LinearGradient id="band" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0.3" stopColor={surface} stopOpacity={0} />
                <Stop offset="0.5" stopColor={surface} stopOpacity={0.7} />
                <Stop offset="0.7" stopColor={surface} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width={w} height="100%" fill="url(#band)" />
          </Svg>
        </Animated.View>
      )}
    </View>
  );
}
