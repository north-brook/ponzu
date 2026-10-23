import { StatusBar } from "expo-status-bar";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type HostInstance,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  makeMutable,
  runOnJS,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { at, CURVES, IDLE, TO_DESIGNS, TO_TILE } from "../lib/handoff";
import { LAUNCH, LAUNCH_LIFT } from "../lib/mark";
import { Store, useStore } from "../lib/store";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { SliceMark } from "./icons";

/**
 * The launch screen's handoff to the first screen, as one shared element:
 * the yuzu screen and its slice become the next screen's yuzu tile (Connect,
 * Needs Tailscale, Macs not answering) or Designs' lockup. The launch screen
 * starts it and replaces itself; this layer, over the whole app, draws the
 * yuzu, the slice and the wordmark exactly where the launch screen had them,
 * waits for the next screen to say where its tile or lockup is, then runs
 * one clock on the UI thread (lib/handoff.ts has the timing). The next
 * screen's content rises in on the same clock (`HandoffRise`). Under Reduce
 * Motion the launch screen doesn't start one, and is simply replaced.
 */
export type HandoffKind = "tile" | "designs";

interface Target {
  x: number;
  y: number;
  size: number;
}

/** The handoff running now, and where it lands once the next screen has drawn. */
export const handoff = new Store<{
  kind: HandoffKind;
  target: Target | null;
  /** How far above its usual place the launch screen had the slice (lifted for a waking Mac). */
  lift: number;
} | null>(null);
/** Milliseconds into the handoff; IDLE when none runs, so every part sits in place. */
const clock = makeMutable(IDLE);
/** Which handoff the clock runs: 0 none, 1 onto a tile, 2 onto Designs. */
const running = makeMutable(0);
const KINDS = { tile: 1, designs: 2 } as const;
// Plain arrays, so worklets capture them.
const out = [...CURVES.out] as const;
const easeIn = [...CURVES.in] as const;
const ease = [...CURVES.ease] as const;

/** Starts a handoff. The launch screen calls it just before it replaces itself. */
export function startHandoff(kind: HandoffKind, lift = 0) {
  cancelAnimation(clock);
  clock.value = 0;
  running.value = KINDS[kind];
  handoff.set({ kind, target: null, lift });
}

function finish() {
  handoff.set(null);
  running.value = 0;
  clock.value = IDLE;
}

/** The layer itself, mounted once over the navigator. Nothing while no handoff runs. */
export function HandoffLayer() {
  const h = useStore(handoff);
  if (!h) return null;
  return <Layer kind={h.kind} target={h.target} lift={h.lift} />;
}

function Layer({ kind, target, lift }: { kind: HandoffKind; target: Target | null; lift: number }) {
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { color } = useTheme();
  const times = kind === "tile" ? TO_TILE : TO_DESIGNS;
  // The launch screen's ink on the status bar while the yuzu is under it.
  const [inked, setInked] = useState(true);
  // Where the launch screen draws the slice (lib/mark.ts) and the wordmark under it.
  const from = { cx: W / 2, cy: H / 2 - LAUNCH_LIFT - lift, size: LAUNCH.mark };
  const wordTop = from.cy + LAUNCH.mark / 2 + LAUNCH.gap;
  // If the next screen never says, its design's place.
  const land =
    target ??
    (kind === "tile"
      ? { x: 28, y: insets.top + 56, size: 64 }
      : { x: 20, y: insets.top + 18, size: 28 });
  const markSize = kind === "tile" ? 40 : 28;
  const to = { cx: land.x + land.size / 2, cy: land.y + land.size / 2 };

  // Run once the target is known, or after a moment without one.
  const started = useRef(false);
  useEffect(() => {
    const go = () => {
      if (started.current) return;
      started.current = true;
      clock.value = withTiming(
        times.end,
        { duration: times.end, easing: Easing.linear },
        (done) => {
          if (done) runOnJS(finish)();
        },
      );
      // Onto a tile the yuzu leaves the status bar as it starts to shrink;
      // onto Designs it fades, so the bar turns halfway through.
      const turn =
        kind === "tile" ? TO_TILE.shrink[0] + 80 : (TO_DESIGNS.ink[0] + TO_DESIGNS.ink[1]) / 2;
      setTimeout(() => setInked(false), turn);
    };
    if (target) go();
    const t = setTimeout(go, 700);
    return () => clearTimeout(t);
  }, [target]);

  // Until the next screen starts to rise in, the study shows only the page's
  // background behind the yuzu: this hides the launch screen leaving under it.
  const coverUntil = kind === "tile" ? TO_TILE.rise[0] : TO_DESIGNS.lockup[0];
  const cover = useAnimatedStyle(() => ({ opacity: clock.value < coverUntil ? 1 : 0 }));

  const yuzu = useAnimatedStyle(() => {
    const t = clock.value;
    if (kind === "designs") {
      const p = at(t, TO_DESIGNS.yuzu, easeIn);
      return {
        left: 0,
        top: 0,
        width: W,
        height: H,
        borderRadius: 0,
        opacity: 1 - p,
        transform: [{ scale: 1 + 0.04 * p }],
      };
    }
    const p = at(t, TO_TILE.shrink, out);
    return {
      left: land.x * p,
      top: land.y * p,
      width: W + (land.size - W) * p,
      height: H + (land.size - H) * p,
      borderRadius: SCREEN_RADIUS + (16 - SCREEN_RADIUS) * p,
      opacity: 1,
      transform: [{ scale: 1 }],
    };
  });

  // The slice, drawn at the launch size, moves and scales down onto its target.
  const slice = useAnimatedStyle(() => {
    const t = clock.value;
    const p = kind === "tile" ? at(t, TO_TILE.shrink, out) : at(t, TO_DESIGNS.glide, out);
    return {
      transform: [
        { translateX: (to.cx - from.cx) * p },
        { translateY: (to.cy - from.cy) * p },
        { scale: 1 + (markSize / from.size - 1) * p },
      ],
    };
  });
  // Onto Designs it turns from the launch's ink to the page's.
  const pageInk = useAnimatedStyle(() => ({
    opacity: kind === "designs" ? at(clock.value, TO_DESIGNS.ink, ease) : 0,
  }));

  const word = useAnimatedStyle(() => {
    const t = clock.value;
    const p = kind === "tile" ? at(t, TO_TILE.word, ease) : at(t, TO_DESIGNS.word, easeIn);
    return { opacity: 1 - p, transform: [{ translateY: (kind === "tile" ? 8 : -6) * p }] };
  });

  const box: ViewStyle = {
    position: "absolute",
    left: from.cx - from.size / 2,
    top: from.cy - from.size / 2,
    width: from.size,
    height: from.size,
  };
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="handoff">
      <StatusBar style={inked ? "dark" : "auto"} animated />
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.bg }, cover]} />
      <Animated.View
        style={[
          {
            position: "absolute",
            backgroundColor: brand.yuzu,
            boxShadow: "0 0 0 1px rgba(17,17,16,0.08)",
          },
          yuzu,
        ]}
      />
      <Animated.View style={[box, slice]}>
        <SliceMark size={from.size} color={brand.ink} />
        <Animated.View style={[StyleSheet.absoluteFill, pageInk]}>
          <SliceMark size={from.size} color={color.ink} />
        </Animated.View>
      </Animated.View>
      <Animated.View style={[{ position: "absolute", left: 0, right: 0, top: wordTop }, word]}>
        <Text
          style={{
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: LAUNCH.word,
            lineHeight: LAUNCH.word,
            letterSpacing: -0.05 * LAUNCH.word,
            color: brand.ink,
            textAlign: "center",
          }}
        >
          ponzu
        </Text>
      </Animated.View>
    </View>
  );
}

/** The screen's corner radius on current iPhones, where the yuzu starts. */
const SCREEN_RADIUS = 55;

/**
 * Where a handoff lands: the yuzu tile, or the lockup's mark. It tells the
 * layer where it is, and stays hidden while the handoff runs: the layer's
 * last frame is exactly what it draws.
 */
export function HandoffTarget({
  kind,
  size,
  children,
}: {
  kind: HandoffKind;
  size: number;
  children: ReactNode;
}) {
  const h = useStore(handoff);
  const ref = useRef<HostInstance>(null);
  const waiting = h?.kind === kind;
  const measure = () => {
    if (!waiting || h?.target) return;
    ref.current?.measureInWindow((x, y) => {
      const now = handoff.get();
      if (now?.kind === kind && !now.target) handoff.set({ ...now, target: { x, y, size } });
    });
  };
  // A screen that's already laid out when the handoff starts measures now.
  useEffect(measure, [waiting]);
  return (
    <View
      ref={ref}
      onLayout={measure}
      style={{ width: size, height: size, opacity: waiting ? 0 : 1 }}
    >
      {children}
    </View>
  );
}

/**
 * Part of the next screen, rising in on the handoff's clock: onto a tile,
 * the content and the actions rise 12pt as the study's `later`; onto
 * Designs, part `i` of the page rises 16pt, about 55ms after the one before
 * (the study's delays). In place when no handoff of its kind runs.
 */
export function HandoffRise({
  kind,
  i = 0,
  style,
  children,
}: {
  kind: HandoffKind;
  i?: number;
  style?: ViewStyle;
  children: ReactNode;
}) {
  const mine = KINDS[kind];
  const rise = useAnimatedStyle(() => {
    if (running.value !== mine) return { opacity: 1, transform: [{ translateY: 0 }] };
    const t = clock.value;
    let p: number;
    let dy: number;
    if (mine === KINDS.tile) {
      p = at(t, TO_TILE.rise, out);
      dy = 12;
    } else {
      const d = TO_DESIGNS.delays;
      p = at(t, TO_DESIGNS.rise, out, d[Math.min(i, d.length - 1)]!);
      dy = 16;
    }
    return { opacity: p, transform: [{ translateY: dy * (1 - p) }] };
  });
  return <Animated.View style={[style, rise]}>{children}</Animated.View>;
}

/** The lockup's word, sliding in 14pt from the left onto Designs. */
export function HandoffWord({ children }: { children: ReactNode }) {
  const slide = useAnimatedStyle(() => {
    if (running.value !== KINDS.designs) return { opacity: 1, transform: [{ translateX: 0 }] };
    const p = at(clock.value, TO_DESIGNS.lockup, out);
    return { opacity: p, transform: [{ translateX: -14 * (1 - p) }] };
  });
  return <Animated.View style={slide}>{children}</Animated.View>;
}
