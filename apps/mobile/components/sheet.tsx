import { type ReactNode, useEffect } from "react";
import { type LayoutChangeEvent, Keyboard as RNKeyboard, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedKeyboard,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "../lib/theme";
import { EASE_OUT } from "../lib/tokens";

const ease = Easing.bezier(...EASE_OUT);
const MORPH = { duration: 420, easing: ease };

/**
 * A sheet over the canvas (comment, thread). Floating, 8pt in from the
 * screen's edges with a 38pt radius, until the keyboard is up: then it sits
 * on the keyboard, full width, with 24pt top corners, as the type ⇄ voice
 * study shows. Swipe down to cancel, with no confirm.
 */
export function Sheet({
  children,
  onDismiss,
  onHeight,
  height,
  testID,
  gap = 14,
}: {
  children: ReactNode;
  onDismiss: () => void;
  /** How far the sheet rises from the bottom of the screen, as it changes. */
  onHeight?: (px: number) => void;
  /** A fixed height (the thread sheet's 450). */
  height?: number;
  testID?: string;
  gap?: number;
}) {
  const { color } = useTheme();
  const keyboard = useAnimatedKeyboard();
  const drag = useSharedValue(0);
  const enter = useSharedValue(1);
  const h = useSharedValue(0);
  useEffect(() => {
    enter.value = withTiming(0, { duration: 380, easing: ease });
  }, []);

  /** 0 floating, 1 on the keyboard. */
  const docked = useDerivedValue(() => withTiming(keyboard.height.value > 40 ? 1 : 0, MORPH));
  const style = useAnimatedStyle(() => {
    const d = docked.value;
    const side = 8 * (1 - d);
    const bottom = d > 0 ? keyboard.height.value : 0;
    return {
      left: side,
      right: side,
      bottom: Math.max(side, bottom),
      borderTopLeftRadius: 38 - 14 * d,
      borderTopRightRadius: 38 - 14 * d,
      borderBottomLeftRadius: 38 * (1 - d),
      borderBottomRightRadius: 38 * (1 - d),
      paddingHorizontal: 20 - 4 * d,
      paddingTop: 10 - 2 * d,
      paddingBottom: 40 - 28 * d,
      transform: [{ translateY: Math.max(0, drag.value) + enter.value * (h.value + 40) }],
    };
  });

  const report = (px: number) => onHeight?.(px);
  useDerivedValue(() => {
    const rise = h.value + Math.max(8 * (1 - docked.value), keyboard.height.value);
    runOnJS(report)(Math.round(rise));
  });

  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-20, 20])
    .onUpdate((e) => {
      drag.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 80 || e.velocityY > 800) {
        drag.value = withTiming(h.value + 60, { duration: 220 }, () => runOnJS(close)());
      } else drag.value = withTiming(0, { duration: 220, easing: ease });
    });
  function close() {
    RNKeyboard.dismiss();
    onDismiss();
  }

  const onLayout = (e: LayoutChangeEvent) => {
    h.value = e.nativeEvent.layout.height;
  };
  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        testID={testID}
        onLayout={onLayout}
        style={[
          {
            position: "absolute",
            backgroundColor: color.card,
            boxShadow: `0 -1px 0 ${color.hairline}, 0 -12px 40px rgba(0,0,0,0.12)`,
            gap,
            zIndex: 9,
            ...(height ? { height } : {}),
          },
          style,
        ]}
      >
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 5,
            borderRadius: 3,
            backgroundColor: color.chip,
          }}
        />
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
