import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Close } from "../../components/icons";
import { parsePairUrl } from "../../lib/mac";
import { pair, pairMessage } from "../../lib/macs";
import { reachAll } from "../../lib/reach";
import { track } from "../../lib/telemetry";
import { brand } from "../../lib/tokens";

/**
 * Scan the code (Connect › 4c): the camera, the yuzu corner frame, and the
 * hint. A Ponzu pairing code (`ponzu://pair?host=…`) pairs that Mac and
 * lands on Designs. Dark in light and dark mode alike, as the camera is.
 */
export default function Scan() {
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const [state, setState] = useState<"looking" | "pairing" | { error: string }>("looking");
  const busy = useRef(false);
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) request();
  }, [permission]);

  const onCode = async (data: string) => {
    if (busy.current) return;
    const host = parsePairUrl(data);
    if (!host) return;
    busy.current = true;
    setState("pairing");
    try {
      await pair(host, "qr");
      track("mac paired", { via: "qr" });
      reachAll();
      router.dismissAll();
      router.replace("/designs");
    } catch (err) {
      setState({ error: pairMessage(err, host.split(".")[0]!) });
      setTimeout(() => {
        busy.current = false;
      }, 2_000);
    }
  };

  const denied = permission && !permission.granted && !permission.canAskAgain;
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
          style={{
            width: 44,
            height: 44,
            borderRadius: 999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(40,40,40,0.7)",
          }}
        >
          <Close color="#f4f3ef" />
        </Pressable>
      </View>
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: 95, top: 300, width: 200, height: 200 }}
      >
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
        {state === "pairing" && (
          <View
            style={{
              position: "absolute",
              inset: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ActivityIndicator color={brand.yuzu} />
          </View>
        )}
      </View>
      <View style={{ position: "absolute", left: 24, right: 24, bottom: 70, gap: 6 }}>
        <Text
          style={{
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 19,
            lineHeight: 24.7,
            color: "#f4f3ef",
            textAlign: "center",
          }}
        >
          {denied ? "Ponzu can't use the camera" : "Point at the code on your Mac"}
        </Text>
        <Text
          onPress={denied ? () => Linking.openSettings() : undefined}
          style={{
            fontFamily: "Inter",
            fontSize: 15,
            lineHeight: 21.75,
            color: "rgba(244,243,239,0.7)",
            textAlign: "center",
          }}
        >
          {typeof state === "object"
            ? state.error
            : denied
              ? "Turn on Camera for Ponzu in Settings."
              : "On your Mac: Ponzu › Pair iPhone…"}
        </Text>
      </View>
    </View>
  );
}
