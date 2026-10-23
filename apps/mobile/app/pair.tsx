import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { pair, pairMessage } from "../lib/macs";
import { reachAll } from "../lib/reach";
import { Slice } from "../lib/slice";
import { track } from "../lib/telemetry";
import { brand } from "../lib/tokens";

/**
 * `ponzu://pair?host=<MagicDNS name>&v=1`, opened from the Camera app's
 * scan of the Mac's pairing code: pairs, then Designs. A failure goes to
 * Connect, which says what went wrong.
 */
export default function PairLink() {
  const { host, v } = useLocalSearchParams<{ host?: string; v?: string }>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!host || (v && v !== "1")) {
      router.replace("/connect");
      return;
    }
    pair(host, "qr")
      .then(() => {
        track("mac paired", { via: "qr" });
        reachAll();
        router.replace("/designs");
      })
      .catch((err) => {
        setError(pairMessage(err, host.split(".")[0]!));
        setTimeout(() => router.replace("/connect"), 2_500);
      });
  }, [host, v]);
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: brand.yuzu,
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
      }}
    >
      <Slice size={112} bloom="loop" />
      {error && (
        <Text
          style={{
            marginHorizontal: 32,
            fontFamily: "Inter",
            fontWeight: "500",
            fontSize: 15,
            color: "rgba(17,17,16,0.72)",
            textAlign: "center",
          }}
        >
          {error}
        </Text>
      )}
    </View>
  );
}
