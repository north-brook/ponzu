import { StatusBar } from "expo-status-bar";
import { Text, View } from "react-native";
import Animated, { Easing, FadeInDown } from "react-native-reanimated";
import { LAUNCH } from "../lib/mark";
import { Slice } from "../lib/slice";
import { useHideSplash } from "../lib/splash";
import { EASE_OUT } from "../lib/tokens";

/**
 * Launch (the iPhone design's Connect › 1 Launch): the slice on yuzu where
 * the native splash left it, blooming while Ponzu looks for your Macs, with
 * the wordmark rising in under it. Yuzu in light and dark alike.
 */
export default function Launch() {
  useHideSplash();
  return (
    <View
      testID="launch"
      className="flex-1 items-center justify-center bg-yuzu"
      style={{ paddingTop: LAUNCH.top, paddingBottom: LAUNCH.bottom, gap: LAUNCH.gap }}
    >
      <StatusBar style="dark" />
      <Slice size={LAUNCH.mark} bloom="loop" />
      <Animated.View
        entering={FadeInDown.delay(500)
          .duration(500)
          .withInitialValues({ transform: [{ translateY: 10 }] })
          .easing(Easing.bezier(...EASE_OUT))}
      >
        <Text
          className="font-display font-bold text-ink"
          style={{
            fontSize: LAUNCH.word,
            lineHeight: LAUNCH.word,
            letterSpacing: -0.05 * LAUNCH.word,
          }}
        >
          ponzu
        </Text>
      </Animated.View>
    </View>
  );
}
