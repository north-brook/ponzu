import { useEffect, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Rect } from "react-native-svg";
import { brand } from "../lib/tokens";
import { useSeen } from "../lib/use-seen";

const ARect = Animated.createAnimatedComponent(Rect);

/**
 * The yuzu trace round a card while an agent works in it, as desktop draws
 * it: a 1px hairline, and over it 2.5px dashes (10.67 on, 6 off, on a
 * 100-unit path) running round once every 9.6s.
 */
export function Trace({
  radius,
  inset = 0.75,
  width = 2.5,
  hairline = true,
  outset = 0,
}: {
  radius: number;
  inset?: number;
  width?: number;
  hairline?: boolean;
  /** Draw this far outside the box. */
  outset?: number;
}) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const offset = useSharedValue(0);
  const still = useReducedMotion();
  // Holds where it is while nobody can see it (the app away, or its screen under another);
  // it picks up from there.
  const awake = useSeen();
  useEffect(() => {
    if (still || !awake) return;
    // The pattern repeats every 100 units, so a lap from wherever it stands is seamless. It
    // starts from there too: the repeat runs from the value it finds, and left past -100 a lap
    // would go from where it is to where it is, and the trace would stand still.
    const from = offset.value % 100;
    offset.value = from;
    offset.value = withRepeat(
      withTiming(from - 100, { duration: 9600, easing: Easing.linear }),
      -1,
    );
    return () => cancelAnimation(offset);
  }, [still, awake]);
  const w = size.w - inset * 2;
  const h = size.h - inset * 2;
  const r = radius - inset;
  // react-native-svg has no pathLength: scale the 100-unit pattern to the real perimeter.
  const unit = Math.max(0, 2 * (w + h) - (8 - 2 * Math.PI) * r) / 100;
  const props = useAnimatedProps(() => ({ strokeDashoffset: offset.value * unit }));
  const onLayout = (e: LayoutChangeEvent) =>
    setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { margin: -outset, zIndex: 3 }]}
      onLayout={onLayout}
    >
      {size.w > 0 && (
        <Svg width={size.w} height={size.h}>
          {hairline && (
            <Rect
              x={inset}
              y={inset}
              width={w}
              height={h}
              rx={r}
              fill="none"
              stroke={brand.yuzu}
              strokeWidth={1}
            />
          )}
          <ARect
            x={inset}
            y={inset}
            width={w}
            height={h}
            rx={r}
            fill="none"
            stroke={brand.yuzu}
            strokeWidth={width}
            strokeLinecap="round"
            strokeDasharray={[10.67 * unit, 6 * unit]}
            animatedProps={props}
          />
        </Svg>
      )}
    </View>
  );
}
