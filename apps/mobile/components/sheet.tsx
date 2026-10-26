import { type ReactNode, useEffect, useRef } from "react";
import { type LayoutChangeEvent, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardController, useKeyboardHandler } from "react-native-keyboard-controller";
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
 * The iOS 26 keyboard's top corner radius, measured on the simulator (iOS 26.5,
 * 402 and 390pt): its curve meets the side about 34pt below its top edge.
 */
const KEYBOARD_CORNER = 34;

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
  right = 0,
  away = false,
  onAway,
}: {
  children: ReactNode;
  onDismiss: () => void;
  /**
   * Leaving (a comment sent): the keyboard goes down and the sheet rides it off the bottom
   * of the screen, then `onAway`. Back to false, it comes back up.
   */
  away?: boolean;
  onAway?: () => void;
  /** How far the sheet rises from the bottom of the screen, as it changes. */
  onHeight?: (px: number) => void;
  /** A fixed height (the thread sheet's 450). */
  height?: number;
  testID?: string;
  gap?: number;
  /** Kept clear on the right: iPhone Duo's rail, where the system puts its bars. */
  right?: number;
}) {
  const { color } = useTheme();
  const { width, height: screenH } = useWindowDimensions();
  /** The bottom corners, floating: the display's less the 8pt inset. */
  const foot = concentric(width, screenH, 8);
  // The keyboard's top, every frame on the UI thread, interactive dismissal included.
  // On iOS the provider's shared values (useReanimatedKeyboardAnimation) jump to where the
  // keyboard is going as it starts to move; onMove reports where it is, frame by frame.
  const keyboardTop = useSharedValue(0);
  /** The keyboard's full height while it's up, for the docked share below. */
  const full = useSharedValue(0);

  useKeyboardHandler(
    {
      onStart: (e) => {
        "worklet";
        // Coming up, the frames follow; at the top it's the keyboard's full height.
        if (e.height > 0) full.value = Math.max(full.value, e.height);
      },
      onMove: (e) => {
        "worklet";
        keyboardTop.value = e.height;
      },
      onInteractive: (e) => {
        "worklet";
        keyboardTop.value = e.height;
      },
      onEnd: (e) => {
        "worklet";
        keyboardTop.value = e.height;
        if (e.height === 0) full.value = 0;
      },
    },
    [],
  );
  const drag = useSharedValue(0);
  const enter = useSharedValue(1);
  const h = useSharedValue(0);
  useEffect(() => {
    enter.value = withTiming(0, { duration: 380, easing: ease });
  }, []);
  const gone = () => onAway?.();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!away) {
      drag.value = withTiming(0, { duration: 260, easing: ease });
      return;
    }
    // One motion with the keyboard: it drops with the system's animation, the sheet's bottom
    // edge follows it, and the sheet slides on past the screen's edge on about the same clock.
    KeyboardController.dismiss().catch(() => {});
    drag.value = withTiming(h.value + 60, { duration: 300, easing: ease }, (done) => {
      if (done) runOnJS(gone)();
    });
  }, [away]);

  const lift = useDerivedValue(() => Math.max(0, keyboardTop.value));
  /**
   * 0 floating, 1 on the keyboard: how far up the keyboard is, from its live
   * height alone, so the shape and the position move together on every frame
   * and can't disagree (progress and height part ways during an interactive
   * dismissal).
   */
  const docked = useDerivedValue(() => (full.value > 0 ? Math.min(1, lift.value / full.value) : 0));
  const style = useAnimatedStyle(() => {
    const d = docked.value;
    const side = 8 * (1 - d);
    // Docked, the sheet runs on behind the keyboard by the keyboard's own top corner
    // (KEYBOARD_CORNER), so the keyboard's curve sits over the sheet's color, never over
    // a square corner or the canvas. It grows in with the keyboard and is gone below it.
    const under = KEYBOARD_CORNER * d;
    return {
      left: side,
      right: right + side,
      // One continuous edge: 8pt off the bottom floating, the keyboard's top docked.
      bottom: side + lift.value - under,
      borderTopLeftRadius: 38 - 14 * d,
      borderTopRightRadius: 38 - 14 * d,
      borderBottomLeftRadius: foot * (1 - d),
      borderBottomRightRadius: foot * (1 - d),
      paddingHorizontal: 20 - 4 * d,
      paddingTop: 10 - 2 * d,
      paddingBottom: 40 - 28 * d + under,
      // The design's sheet spaces its rows 14pt floating, 10pt on the keyboard.
      gap: gap - (gap - 10) * d,
      transform: [{ translateY: Math.max(0, drag.value) + enter.value * (h.value + 40) }],
    };
  });

  const report = (px: number) => onHeight?.(px);
  useDerivedValue(() => {
    // The top of the sheet from the bottom of the screen: its bottom edge plus its height.
    const under = KEYBOARD_CORNER * docked.value;
    const rise = 8 * (1 - docked.value) + lift.value - under + h.value;
    runOnJS(report)(Math.round(Math.max(0, rise)));
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
  // Closing waits for the keyboard to finish going down, so the sheet rides it all the way
  // rather than leaving with it half down.
  function close() {
    KeyboardController.dismiss()
      .catch(() => {})
      .finally(onDismiss);
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
