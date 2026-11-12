import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "../lib/theme";
import { brand, EASE_OUT } from "../lib/tokens";
import { Glass } from "./glass";
import { Check } from "./icons";

const ease = Easing.bezier(...EASE_OUT);

/**
 * One line on glass over the canvas, at its foot: how to place a comment (after the Comment
 * button), shown until the pin is down. The glass is never faded (components/glass.tsx).
 */
export function CanvasHint({ text, bottom }: { text: string; bottom: number }) {
  const { color } = useTheme();
  return (
    <Animated.View
      pointerEvents="none"
      testID="canvas-hint"
      entering={ZoomIn.duration(200).easing(ease)}
      style={{ position: "absolute", left: 0, right: 0, bottom, alignItems: "center", zIndex: 8 }}
    >
      <Glass
        style={{ height: 32, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" }}
      >
        <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.ink }}>
          {text}
        </Text>
      </Glass>
    </Animated.View>
  );
}

/**
 * Moving an unsent comment's pin: "Move the canvas under the pin" rises in at the canvas's foot,
 * holds, and gives way to Done, which puts the pin down on the layer under it.
 */
export function MoveBar({
  bottom,
  left,
  width,
  onDone,
}: {
  bottom: number;
  /** The canvas's part of the window, which it's centred in. */
  left: number;
  width: number;
  onDone: () => void;
}) {
  const { color } = useTheme();
  const t = useSharedValue(0);
  const [shown, setShown] = useState(true);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const off = setTimeout(() => setShown(false), 300 + 1_500);
    t.value = withSequence(
      withTiming(1, { duration: 300, easing: ease }),
      withDelay(
        1_500,
        withTiming(0, { duration: 250, easing: ease }, (end) => {
          if (end) scheduleOnRN(setDone, true);
        }),
      ),
    );
    return () => clearTimeout(off);
  }, []);
  const move = useAnimatedStyle(() => ({
    transform: [{ translateY: 12 * (1 - t.value) }, { scale: 0.96 + 0.04 * t.value }],
  }));
  const words = useAnimatedStyle(() => ({ opacity: t.value }));
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", bottom, left, width, alignItems: "center", zIndex: 8 }}
    >
      {done ? (
        <Animated.View entering={ZoomIn.duration(220)}>
          <Pressable
            onPress={onDone}
            accessibilityRole="button"
            accessibilityLabel="Done"
            testID="move-done"
            style={({ pressed }) => ({
              height: 48,
              paddingLeft: 20,
              paddingRight: 24,
              borderRadius: 999,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: brand.yuzu,
              boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Check size={18} color={brand.ink} />
            <Text
              style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 15, color: brand.ink }}
            >
              Done
            </Text>
          </Pressable>
        </Animated.View>
      ) : (
        <Animated.View pointerEvents="none" testID="move-hint" style={move}>
          <Glass
            shown={shown}
            style={{
              height: 32,
              paddingHorizontal: 14,
              flexDirection: "row",
              alignItems: "center",
            }}
          >
            <Animated.Text
              style={[
                { fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: color.ink },
                words,
              ]}
            >
              Move the canvas under the pin
            </Animated.Text>
          </Glass>
        </Animated.View>
      )}
    </View>
  );
}
