import { useEffect, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { PhoneFile } from "../lib/files";
import { useScheme, useTheme } from "../lib/theme";
import { Glass } from "./glass";
import { MacImage } from "./preview";

/**
 * What the canvas shows while its page loads: what the phone already has.
 * The design's preview (its Designs card's, from the cache) framed as the
 * canvas frames a page, in the space between the bar and the home indicator,
 * with a board's corners and hairline. It's content, not a loader: the
 * loading signal is the file pill's slice juicing (app/design/[mac]/[key].tsx).
 * With no preview, the canvas's color alone. It cross-fades into the live
 * canvas once the canvas has drawn (`drawn`). A Mac that isn't answering is
 * a problem, so it says so in a glass card over it.
 */
export function CanvasPlaceholder({
  file,
  drawn,
  top,
  bottom,
  offline,
}: {
  file: PhoneFile | null;
  /** The canvas has drawn its first page: fade away. */
  drawn: boolean;
  /** The bar's foot and the home indicator's head, from the screen's edges. */
  top: number;
  bottom: number;
  /** "<Mac> isn't answering. Trying again…", over it. */
  offline: string | null;
}) {
  const { color, shadow } = useTheme();
  const scheme = useScheme();
  const fade = useSharedValue(1);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!drawn) return;
    fade.value = withTiming(0, { duration: 250, easing: Easing.out(Easing.quad) });
    const t = setTimeout(() => setGone(true), 260);
    return () => clearTimeout(t);
  }, [drawn]);
  const style = useAnimatedStyle(() => ({ opacity: fade.value }));
  // The preview's own aspect, so it's framed whole as the canvas frames a page.
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [aspect, setAspect] = useState(16 / 11);
  if (gone) return null;
  const url = file?.preview ? `${file.preview}&theme=${scheme}` : null;
  const pad = 24;
  const w = Math.max(0, Math.min(area.w - 2 * pad, (area.h - 2 * pad) * aspect));
  const h = w / aspect;
  return (
    <Animated.View
      pointerEvents="none"
      testID="canvas-placeholder"
      style={[StyleSheet.absoluteFill, { backgroundColor: color.canvas }, style]}
    >
      <View
        style={{ position: "absolute", left: 0, right: 0, top, bottom }}
        onLayout={(e: LayoutChangeEvent) =>
          setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
        }
      >
        {url && w > 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <View
              style={{
                width: w,
                height: h,
                borderRadius: 2,
                overflow: "hidden",
                boxShadow: shadow.board,
                backgroundColor: color.card,
              }}
            >
              <MacImage
                mac={file!.mac}
                url={url}
                live={!file!.stale}
                contentFit="cover"
                onSize={(iw, ih) => iw > 0 && ih > 0 && setAspect(iw / ih)}
                style={{ width: "100%", height: "100%" }}
              />
            </View>
          </View>
        ) : null}
        {offline && (
          <Animated.View
            entering={FadeIn.duration(220)}
            testID="canvas-offline"
            style={{ position: "absolute", left: 24, right: 24, bottom: 24, alignItems: "center" }}
          >
            <Glass style={{ borderRadius: 18, paddingVertical: 12, paddingHorizontal: 16 }}>
              <Text
                style={{
                  fontFamily: "Inter",
                  fontWeight: "500",
                  fontSize: 14,
                  lineHeight: 19,
                  color: color.ink,
                  textAlign: "center",
                }}
              >
                {offline}
              </Text>
            </Glass>
          </Animated.View>
        )}
      </View>
    </Animated.View>
  );
}
