import { useSessionState } from "@ponzu/client/react";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInDown, useReducedMotion } from "react-native-reanimated";
import { startHandoff } from "../components/handoff";
import { backend } from "../lib/cloud/backend";
import { gateRoute } from "../lib/cloud/gate";
import { useSetupStep } from "../lib/cloud/use-setup";
import { LAUNCH } from "../lib/mark";
import { BLOOM_IN_MS, Slice } from "../lib/slice";
import { useHideSplash } from "../lib/splash";
import { brand, EASE_OUT } from "../lib/tokens";

/** How long the launch waits before it says it can't reach Ponzu. */
const SLOW_LAUNCH_MS = 8_000;
const SLOW_LAUNCH_LINE = "Can't reach Ponzu. Trying again.";

/**
 * Launch (onboarding 4.7): on the native splash's yuzu, the slice blooms in, then keeps blooming
 * while the app reads the session from the Keychain, with the wordmark rising in under it. Then
 * it goes on by itself, to the screen the session calls for (lib/cloud/gate.ts): sign in, the
 * update screen, setup's next step, or the canvases. It never leaves before the bloom-in has landed, so a fast
 * answer doesn't flash it; under Reduce Motion the slice is whole from the start.
 */
export default function Launch() {
  useHideSplash();
  const state = useSessionState(backend.session);
  const [prepared, setPrepared] = useState(false);
  const [slow, setSlow] = useState(false);
  const still = useReducedMotion();
  const gone = useRef(false);
  /** When the slice started blooming in. */
  const mounted = useRef(Date.now());

  useEffect(() => {
    let on = true;
    backend
      .prepare()
      .catch(() => {})
      .then(() => on && setPrepared(true));
    const t = setTimeout(() => on && setSlow(true), SLOW_LAUNCH_MS);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, []);

  // Signed in, launch waits for where setup stands. With no `me` at all (offline on a first
  // launch since the cache went), the canvases say what there is.
  const setup = useSetupStep();
  const target = prepared
    ? gateRoute(state, setup.step ?? (setup.unreachable ? "done" : null))
    : null;
  useEffect(() => {
    if (!target || gone.current) return;
    const landed = still ? 0 : mounted.current + BLOOM_IN_MS - Date.now();
    const t = setTimeout(
      () => {
        gone.current = true;
        // The yuzu and its slice carry on into the canvases' lockup.
        if (!still && target === "/canvases") startHandoff("designs");
        router.replace(target);
      },
      Math.max(still ? 0 : 600, landed),
    );
    return () => clearTimeout(t);
  }, [target, still]);

  return (
    <View
      testID="launch"
      accessibilityLabel="Ponzu"
      style={{ flex: 1, backgroundColor: brand.yuzu }}
    >
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
            style={{
              fontFamily: "Funnel Display",
              fontWeight: "700",
              fontSize: LAUNCH.word,
              lineHeight: LAUNCH.word,
              letterSpacing: -0.05 * LAUNCH.word,
              color: brand.ink,
            }}
          >
            ponzu
          </Text>
        </Animated.View>
        {slow && !target && (
          <Animated.Text
            entering={FadeIn.duration(300)}
            testID="launch-slow"
            style={{
              fontFamily: "Inter",
              fontSize: 15,
              lineHeight: 20,
              color: brand.ink,
              opacity: 0.6,
            }}
          >
            {SLOW_LAUNCH_LINE}
          </Animated.Text>
        )}
      </View>
    </View>
  );
}
