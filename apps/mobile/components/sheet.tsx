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
/** Bare, with the keyboard down: clear of the home indicator. */
const BARE_FOOT = 40;
/** Bare, how far it floats above the keyboard. */
const BARE_LIFT = 8;

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
 *
 * Given a `maxWidth` (a window too wide for a sheet across it: iPhone Duo's
 * inner display sideways, an iPad), it floats centred over the canvas at
 * most that wide, and keeps its floating shape on the keyboard too, 8pt
 * above it with every corner round: it no longer spans the keyboard's top,
 * so it can't dock on it. The keyboard still carries it, frame by frame.
 * It stays above `bottomBar`, the system's bottom bar, until the keyboard
 * rises past it.
 *
 * `bare` (a new comment) draws no sheet at all: what it holds floats on its
 * own over the canvas, 8pt above the keyboard, or `BARE_FOOT` above the
 * bottom with the keyboard down, 12pt in from the sides. It still rides the
 * keyboard, leaves with it, and is swiped down to cancel.
 */
export function Sheet({
  children,
  onDismiss,
  onHeight,
  height,
  top,
  testID,
  gap = 14,
  right = 0,
  maxWidth,
  bottomBar = 0,
  panel,
  away = false,
  onAway,
  bare = false,
}: {
  children: ReactNode;
  /** No surface, no grabber: only what it holds, floating over the canvas. */
  bare?: boolean;
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
  /**
   * Its top edge, from the top of the screen (the chat sheet's, near full height): it reaches
   * down to its bottom edge, so it shortens as the keyboard rises rather than going off the top.
   */
  top?: number;
  testID?: string;
  gap?: number;
  /** Kept clear on the right: iPhone Duo's rail, where the system puts its bars. */
  right?: number;
  /** The widest it gets, centred in what's left of `right` (lib/duo-layout.ts `sheetMax`). */
  maxWidth?: number;
  /**
   * What the system's bottom bar takes at the foot (its toolbar, with Comments, on iPhone Duo
   * open upright and an iPad): the sheet stays above it, where the toolbar can't take its
   * touches, or above the keyboard once that's higher.
   */
  bottomBar?: number;
  /**
   * Docked as a panel this wide at the trailing edge (the chat in a window with room for it beside
   * the canvas, lib/duo-layout.ts `chatPanel`): from `top` to 8pt above the bottom, or above the
   * keyboard, every corner round, coming in from the side. It leaves `right` clear, as a sheet does.
   */
  panel?: number;
}) {
  const { color } = useTheme();
  const { width, height: screenH } = useWindowDimensions();
  /** The bottom corners, floating: the display's less the 8pt inset. */
  const foot = concentric(width, screenH, 8);
  /** Floats whatever the keyboard does, inset this far either side to be centred. */
  const floats = maxWidth !== undefined;
  const inset = floats ? Math.max(8, (width - right - maxWidth) / 2) : 0;
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
    drag.value = withTiming(h.value + bottomBar + 60, { duration: 300, easing: ease }, (done) => {
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
  /** Bare: its bottom edge from the bottom of the screen. */
  const bareBottom = useDerivedValue(() =>
    Math.max(BARE_FOOT, bottomBar + BARE_LIFT, lift.value + BARE_LIFT),
  );
  const style = useAnimatedStyle(() => {
    if (panel !== undefined) {
      return {
        right: right + 8,
        width: panel,
        bottom: 8 + Math.max(bottomBar, lift.value),
        borderRadius: 24,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: 16,
        gap,
        transform: [
          { translateX: enter.value * (panel + right + 16) },
          { translateY: Math.max(0, drag.value) },
        ],
      };
    }
    if (bare) {
      const side = floats ? inset : 12;
      return {
        left: side,
        right: right + side,
        bottom: bareBottom.value,
        gap: 8,
        transform: [
          {
            translateY: Math.max(0, drag.value) + enter.value * (h.value + bareBottom.value + 20),
          },
        ],
      };
    }
    const d = docked.value;
    const side = floats ? 8 : 8 * (1 - d);
    // Docked, the sheet runs on behind the keyboard by the keyboard's own top corner
    // (KEYBOARD_CORNER), so the keyboard's curve sits over the sheet's color, never over
    // a square corner or the canvas. It grows in with the keyboard and is gone below it.
    // Floating, it never docks: nothing runs under.
    const under = floats ? 0 : KEYBOARD_CORNER * d;
    const top = 38 - 14 * d;
    // Floating on the keyboard, its bottom corners are its top ones, off the display's.
    const bottom = floats ? foot + (top - foot) * d : foot * (1 - d);
    return {
      left: floats ? inset : side,
      right: right + (floats ? inset : side),
      // One continuous edge: 8pt off the bottom floating, the keyboard's top docked.
      bottom: side + Math.max(bottomBar, lift.value) - under,
      borderTopLeftRadius: top,
      borderTopRightRadius: top,
      borderBottomLeftRadius: bottom,
      borderBottomRightRadius: bottom,
      paddingHorizontal: 20 - 4 * d,
      paddingTop: 10 - 2 * d,
      paddingBottom: 40 - 28 * d + under,
      // The design's sheet spaces its rows 14pt floating, 10pt on the keyboard.
      gap: gap - (gap - 10) * d,
      // Raised over a bottom bar, it has that much further to go to be off the screen.
      transform: [
        { translateY: Math.max(0, drag.value) + enter.value * (h.value + bottomBar + 40) },
      ],
    };
  });

  const report = (px: number) => onHeight?.(px);
  useDerivedValue(() => {
    // The top of the sheet from the bottom of the screen: its bottom edge plus its height.
    if (bare) {
      runOnJS(report)(Math.round(bareBottom.value + h.value));
      return;
    }
    // Beside the canvas, not over its foot: nothing on the canvas needs to clear it.
    if (panel !== undefined) {
      runOnJS(report)(0);
      return;
    }
    const under = floats ? 0 : KEYBOARD_CORNER * docked.value;
    const rise =
      (floats ? 8 : 8 * (1 - docked.value)) + Math.max(bottomBar, lift.value) - under + h.value;
    runOnJS(report)(Math.round(Math.max(0, rise)));
  });

  const pan = Gesture.Pan()
    // Leaving, the sheet is the slide's: a drag would stop it short of `onAway`.
    .enabled(!away)
    .activeOffsetY(8)
    .failOffsetX([-20, 20])
    .onUpdate((e) => {
      drag.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 80 || e.velocityY > 800) {
        drag.value = withTiming(h.value + bottomBar + 60, { duration: 220 }, () =>
          runOnJS(close)(),
        );
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
        // VoiceOver's escape (a two-finger scrub) closes it, as a swipe down does.
        onAccessibilityEscape={away ? undefined : close}
        style={[
          {
            position: "absolute",
            zIndex: 9,
            ...(bare
              ? {}
              : {
                  backgroundColor: color.card,
                  boxShadow: `0 -1px 0 ${color.hairline}, 0 -12px 40px rgba(0,0,0,0.12)`,
                }),
            ...(height ? { height } : {}),
            ...(top !== undefined && !bare ? { top } : {}),
          },
          style,
        ]}
      >
        {!bare && (
          <View
            style={{
              alignSelf: "center",
              width: 36,
              height: 5,
              borderRadius: 3,
              backgroundColor: color.chip,
            }}
          />
        )}
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
