import { CameraView, useCameraPermissions } from "expo-camera";
import { GlassView } from "expo-glass-effect";
import { router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import Animated, { Easing, FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { liquid } from "../../components/glass";
import { Close } from "../../components/icons";
import { fail as failHaptic, success } from "../../lib/haptics";
import { PairError, parsePairUrl } from "../../lib/mac";
import { pairMessage, usePair } from "../../lib/macs";
import { reachAll } from "../../lib/reach";
import { Juice } from "../../lib/slice";
import { track } from "../../lib/telemetry";
import { brand, EASE_OUT } from "../../lib/tokens";

/** How long an error stays up, with scanning paused, before it looks again. */
const PAUSE = 3_500;
const ease = Easing.bezier(...EASE_OUT);
const light = "#f4f3ef";

type State = "looking" | "pairing" | { error: string };

/**
 * Scan the code (Connect › 4c): the camera filling the screen, the yuzu
 * corner frame, the glass close button, and what to do in a dark pill at
 * the bottom, the same pill as the canvas's gesture hint. A Ponzu pairing
 * code (`ponzu://pair?host=…`) pairs that Mac and lands on Designs. If
 * pairing fails, the pill says why in its error style, with an error
 * haptic, and scanning waits a moment before it looks again. Dark in light
 * and dark mode alike, as the camera is.
 */
export default function Scan() {
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const [state, setState] = useState<State>("looking");
  const busy = useRef(false);
  const { mutateAsync: pair } = usePair();
  // Development: `?error=<host>` shows the error pill as a too-old Mac.
  const { error: devError } = useLocalSearchParams<{ error?: string }>();
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) request();
  }, [permission]);

  const fail = (message: string) => {
    failHaptic();
    setState({ error: message });
    setTimeout(() => {
      busy.current = false;
      setState("looking");
    }, PAUSE);
  };
  useEffect(() => {
    if (__DEV__ && devError) {
      busy.current = true;
      fail(pairMessage(new PairError("tooOld", "dev", "0.1.0"), devError));
    }
  }, [devError]);

  const onCode = async (data: string) => {
    if (busy.current) return;
    const host = parsePairUrl(data);
    if (!host) return;
    busy.current = true;
    setState("pairing");
    try {
      await pair({ host, via: "qr" });
      success();
      track("mac paired", { via: "qr" });
      reachAll();
      router.dismissAll();
      router.replace("/designs");
    } catch (err) {
      fail(pairMessage(err, host.split(".")[0]!));
    }
  };

  const denied = permission && !permission.granted && !permission.canAskAgain;
  const error = typeof state === "object" ? state.error : null;
  return (
    <View testID="scan-screen" style={{ flex: 1, backgroundColor: "#0e0e0d" }}>
      <StatusBar style="light" />
      {permission?.granted && (
        <CameraView
          style={{ position: "absolute", inset: 0 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={state === "looking" ? (r) => onCode(r.data) : undefined}
        />
      )}
      <View
        style={{
          paddingTop: insets.top + 6,
          paddingHorizontal: 16,
          flexDirection: "row",
          justifyContent: "flex-end",
        }}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={6}
          testID="scan-close"
        >
          <GlassView
            colorScheme="dark"
            isInteractive
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: liquid ? undefined : "rgba(40,40,40,0.7)",
            }}
          >
            <Close color={light} />
          </GlassView>
        </Pressable>
      </View>
      <Frame pairing={state === "pairing"} />
      {/* The design's hint text ends 70pt above the bottom edge; the pill pads it 12. */}
      {/* box-none: the camera behind stays touchable, and the denied state's Settings link works. */}
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", left: 24, right: 24, bottom: 58, alignItems: "center" }}
      >
        <Animated.View
          key={error ? "error" : denied ? "denied" : "hint"}
          entering={FadeIn.duration(220).easing(ease)}
          exiting={FadeOut.duration(160)}
          layout={LinearTransition.duration(220).easing(ease)}
          testID={error ? "scan-error" : "scan-hint"}
          style={{
            maxWidth: "100%",
            paddingVertical: 12,
            paddingHorizontal: 18,
            borderRadius: 22,
            borderCurve: "continuous",
            // The gesture hint's dark pill; an error is the danger red, unmistakable on any camera image.
            backgroundColor: error ? "rgba(217,58,43,0.94)" : "rgba(17,17,16,0.82)",
            gap: 4,
            alignItems: "center",
          }}
        >
          <Text
            style={{
              fontFamily: "Inter",
              fontWeight: "600",
              fontSize: error ? 16 : 19,
              lineHeight: error ? 21 : 24.7,
              color: light,
              textAlign: "center",
            }}
          >
            {error
              ? "Couldn't pair with that Mac"
              : denied
                ? "Ponzu can't use the camera"
                : "Point at the code on your Mac"}
          </Text>
          <Text
            onPress={denied && !error ? () => Linking.openSettings() : undefined}
            style={{
              fontFamily: "Inter",
              fontSize: 15,
              lineHeight: 21.75,
              color: error ? light : "rgba(244,243,239,0.7)",
              textAlign: "center",
            }}
          >
            {error ??
              (denied
                ? "Turn on Camera for Ponzu in Settings."
                : "On your Mac: Ponzu › Pair iPhone…")}
          </Text>
        </Animated.View>
      </View>
    </View>
  );
}

/** The yuzu corners, 200pt, in the middle of the screen: the design's at 390 × 844. */
function Frame({ pairing }: { pairing: boolean }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        alignItems: "center",
        justifyContent: "center",
        // 300pt from the top on an 844pt screen: 22pt above the middle.
        paddingBottom: 44,
      }}
    >
      <View style={{ width: 200, height: 200 }}>
        {(["tl", "tr", "bl", "br"] as const).map((c) => (
          <View
            key={c}
            style={{
              position: "absolute",
              width: 44,
              height: 44,
              borderColor: brand.yuzu,
              [c[0] === "t" ? "top" : "bottom"]: 0,
              [c[1] === "l" ? "left" : "right"]: 0,
              [c[0] === "t" ? "borderTopWidth" : "borderBottomWidth"]: 4,
              [c[1] === "l" ? "borderLeftWidth" : "borderRightWidth"]: 4,
              [`border${c[0] === "t" ? "Top" : "Bottom"}${c[1] === "l" ? "Left" : "Right"}Radius`]: 18,
            }}
          />
        ))}
        {pairing && (
          <View
            style={{
              position: "absolute",
              inset: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Juice size={28} color={brand.yuzu} />
          </View>
        )}
      </View>
    </View>
  );
}
