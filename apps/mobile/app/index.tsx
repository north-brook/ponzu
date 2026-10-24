import { useIsRestoring } from "@tanstack/react-query";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { Easing, FadeInDown, useReducedMotion } from "react-native-reanimated";
import { startHandoff } from "../components/handoff";
import { boot } from "../lib/boot";
import { LAUNCH } from "../lib/mark";
import { reachAll, reaching, useMacs } from "../lib/reach";
import { BLOOM_IN_MS, Slice } from "../lib/slice";
import { useHideSplash } from "../lib/splash";
import { EASE_OUT } from "../lib/tokens";

/**
 * Launch (the iPhone design's Connect › 1 Launch): on the native splash's
 * yuzu, the slice blooms in from nothing (`bloomin`), then keeps blooming
 * while Ponzu looks for your Macs, with the wordmark rising in under it.
 * Yuzu in light and dark alike.
 *
 * It asks every saved Mac where it stands, then goes on: no Macs → Connect;
 * one answers → Designs; none on the tailnet → Tailscale; all asleep → "Your
 * Macs aren't answering". While a Mac's Ponzu starts, the slice simply keeps
 * blooming: loading is the slice moving where it already is, and nothing
 * joins or moves the column. A Mac that doesn't wake is the asleep screen.
 */
export default function Launch() {
  useHideSplash();
  const { overall } = useMacs();
  const [booted, setBooted] = useState(false);
  // Designs opens onto the cached catalogs, so wait until they're back.
  const restoring = useIsRestoring();
  const ready = booted && !restoring;
  const gone = useRef(false);
  const still = useReducedMotion();
  /** When the slice started blooming in: the handoff never leaves before it's whole. */
  const mounted = useRef(Date.now());
  useEffect(() => {
    let on = true;
    boot().then(() => {
      if (!on) return;
      setBooted(true);
      // Coming back here (Try again, or a fresh start in development) asks again.
      if (!reaching.get()) reachAll();
    });
    return () => {
      on = false;
    };
  }, []);

  useEffect(() => {
    if (!ready || gone.current) return;
    const go = (to: "/connect" | "/designs" | "/tailscale" | "/asleep") => {
      gone.current = true;
      // The yuzu and its slice carry on into the next screen's tile or lockup.
      if (!still) startHandoff(to === "/designs" ? "designs" : "tile");
      router.replace(to);
    };
    // Hold the bloom a beat, so a fast answer doesn't flash the launch screen,
    // and never leave before the bloom-in has landed: the handoff carries the
    // whole slice on. Under Reduce Motion the slice is whole from the start.
    const landed = still ? 0 : mounted.current + BLOOM_IN_MS - Date.now();
    const later = (to: Parameters<typeof go>[0]) => {
      const t = setTimeout(() => go(to), Math.max(600, landed));
      return () => clearTimeout(t);
    };
    switch (overall.state) {
      case "none":
        return later("/connect");
      case "answer":
        return later("/designs");
      case "noTailnet":
        return later("/tailscale");
      case "asleep":
        return later("/asleep");
    }
  }, [ready, overall.state]);

  return (
    <View testID="launch" className="flex-1 bg-yuzu">
      <StatusBar style="dark" />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            alignItems: "center",
            justifyContent: "center",
            paddingTop: LAUNCH.top,
            paddingBottom: LAUNCH.bottom,
            gap: LAUNCH.gap,
          },
        ]}
      >
        <Slice size={LAUNCH.mark} bloom="inThenLoop" />
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
    </View>
  );
}
