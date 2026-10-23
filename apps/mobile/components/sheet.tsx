import { type ReactNode, useEffect } from "react";
import { type LayoutChangeEvent, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  KeyboardController,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { concentric } from "../lib/screen";
import { useTheme } from "../lib/theme";
import { EASE_OUT } from "../lib/tokens";

const ease = Easing.bezier(...EASE_OUT);

/**
 * A sheet over the canvas (comment, thread). Floating, 8pt in from the
 * screen's edges, its top corners 38pt and its bottom ones concentric with
 * the display's (lib/screen.ts), until the keyboard is up: then it sits
 * on the keyboard, full width, with 24pt top corners, as the type ⇄ voice
 * study shows. Its shape follows the keyboard's own frame, every frame on
 * the UI thread (react-native-keyboard-controller): as the keyboard drops
 * the sheet's bottom edge follows it down and its corners round, and as it
 * rises the sheet rides it, interactive dismissal included. Swipe down to
 * cancel, with no confirm.
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
  const { width, height: screenH } = useWindowDimensions();
  /** The bottom corners, floating: the display's less the 8pt inset. */
  const foot = concentric(width, screenH, 8);
  // The keyboard's height (negative, as it lifts content) and how far up it is, 0 to 1.
  const keyboard = useReanimatedKeyboardAnimation();
  const drag = useSharedValue(0);
  const enter = useSharedValue(1);
  const h = useSharedValue(0);
  useEffect(() => {
    enter.value = withTiming(0, { duration: 380, easing: ease });
  }, []);

  /** 0 floating, 1 on the keyboard: wherever the keyboard is on its way. */
  const docked = useDerivedValue(() => Math.min(1, Math.max(0, keyboard.progress.value)));
  const lift = useDerivedValue(() => Math.max(0, -keyboard.height.value));
  const style = useAnimatedStyle(() => {
    const d = docked.value;
    const side = 8 * (1 - d);
    return {
      left: side,
      right: side,
      bottom: Math.max(side, lift.value),
      borderTopLeftRadius: 38 - 14 * d,
      borderTopRightRadius: 38 - 14 * d,
      borderBottomLeftRadius: foot * (1 - d),
      borderBottomRightRadius: foot * (1 - d),
      paddingHorizontal: 20 - 4 * d,
      paddingTop: 10 - 2 * d,
      paddingBottom: 40 - 28 * d,
      // The design's sheet spaces its rows 14pt floating, 10pt on the keyboard.
      gap: gap - (gap - 10) * d,
      transform: [{ translateY: Math.max(0, drag.value) + enter.value * (h.value + 40) }],
    };
  });

  const report = (px: number) => onHeight?.(px);
  useDerivedValue(() => {
    const rise = h.value + Math.max(8 * (1 - docked.value), lift.value);
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
    KeyboardController.dismiss().catch(() => {});
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
