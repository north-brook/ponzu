import { useEffect, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
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
import type { PhoneFile } from "../lib/files";
import { Juice } from "../lib/slice";
import { useScheme, useTheme } from "../lib/theme";
import { MacImage } from "./preview";

/**
 * What the canvas shows while its page loads: what the phone already has.
 * The design's preview (its Designs card's, from the cache) framed as the
 * canvas frames a page, in the space between the bar and the home indicator,
 * with a board's corners and hairline and a soft shimmer sweeping across.
 * With no preview, the slice juicing in the middle. It cross-fades into the
 * live canvas once the canvas has drawn (`drawn`). A Mac that isn't
 * answering says so over it.
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
              <Sweep width={w} color={color.canvas} />
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Juice size={40} color={color.faint} />
          </View>
        )}
        {offline && (
          <View
            style={{ position: "absolute", left: 24, right: 24, bottom: 24, alignItems: "center" }}
          >
            <Text
              style={{ fontFamily: "Inter", fontSize: 15, color: color.muted, textAlign: "center" }}
            >
              {offline}
            </Text>
          </View>
        )}
      </View>
    </Animated.View>
  );
}

/** A soft band of the canvas's color sweeping across the preview every 1.6s, as a loading shimmer. */
function Sweep({ width, color }: { width: number; color: string }) {
  const x = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    x.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.linear }), -1);
    return () => cancelAnimation(x);
  }, [still]);
  const band = useAnimatedStyle(() => ({ transform: [{ translateX: (x.value * 2 - 1) * width }] }));
  if (still) return null;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, band]}>
      <Svg width={width} height="100%">
        <Defs>
          <LinearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0.3" stopColor={color} stopOpacity={0} />
            <Stop offset="0.5" stopColor={color} stopOpacity={0.55} />
            <Stop offset="0.7" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height="100%" fill="url(#sweep)" />
      </Svg>
    </Animated.View>
  );
}
