import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import Animated, { Easing, FadeIn, FadeInDown } from "react-native-reanimated";
import { MacIcon } from "../components/icons";
import { boot } from "../lib/boot";
import { LAUNCH } from "../lib/mark";
import { reachAll, reaching, useMacs } from "../lib/reach";
import { Slice } from "../lib/slice";
import { useHideSplash } from "../lib/splash";
import { EASE_OUT } from "../lib/tokens";

/**
 * Launch (the iPhone design's Connect › 1 Launch): the slice on yuzu where
 * the native splash left it, blooming while Ponzu looks for your Macs, with
 * the wordmark rising in under it. Yuzu in light and dark alike.
 *
 * It asks every saved Mac where it stands, then goes on: no Macs → Connect;
 * one answers → Designs; none on the tailnet → Tailscale; all asleep → "Your
 * Macs aren't answering". While a Mac's Ponzu starts, it says so here
 * (Connect › R1 Waking Ponzu).
 */
export default function Launch() {
  useHideSplash();
  const { overall } = useMacs();
  const { height } = useWindowDimensions();
  const [ready, setReady] = useState(false);
  const gone = useRef(false);
  useEffect(() => {
    let on = true;
    boot().then(() => {
      if (!on) return;
      setReady(true);
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
      router.replace(to);
    };
    // Hold the bloom a beat, so a fast answer doesn't flash the launch screen.
    const later = (to: Parameters<typeof go>[0]) => {
      const t = setTimeout(() => go(to), 600);
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

  const waking = overall.state === "waking" ? overall.mac : null;
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
      {/* Absolute, so the slice stays where the splash put it. */}
      <View
        style={{
          position: "absolute",
          // Under the wordmark: the column's middle is 3pt above the screen's, and the wordmark ends 89pt below that; then the design's 22 + 6.
          top: height / 2 - 3 + 89 + 28,
          left: 0,
          right: 0,
          alignItems: "center",
        }}
      >
        {waking && (
          <Animated.View
            entering={FadeIn.duration(400)}
            testID="waking"
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              height: 34,
              paddingLeft: 10,
              paddingRight: 14,
              borderRadius: 999,
              backgroundColor: "rgba(17,17,16,0.08)",
            }}
          >
            <MacIcon kind={waking.kind} size={16} color="rgba(17,17,16,0.72)" width={1.8} />
            <Text
              style={{
                fontFamily: "Inter",
                fontWeight: "500",
                fontSize: 15,
                color: "rgba(17,17,16,0.72)",
              }}
            >
              Waking Ponzu on {waking.name}
            </Text>
          </Animated.View>
        )}
      </View>
    </View>
  );
}
