import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { boot } from "../lib/boot";
import { pairMessage, usePair } from "../lib/macs";
import { reachAll } from "../lib/reach";
import { Slice } from "../lib/slice";
import { track } from "../lib/telemetry";
import { brand } from "../lib/tokens";

/**
 * `ponzu://pair?host=<MagicDNS name>&v=1`, opened from the Camera app's
 * scan of the Mac's pairing code: pairs, then Designs. A failure says what
 * went wrong, then goes to Tailscale, where pairing starts.
 */
export default function PairLink() {
  const { host, v } = useLocalSearchParams<{ host?: string; v?: string }>();
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: pair } = usePair();
  useEffect(() => {
    // After the saved Macs load: Tailscale tells a paired phone from a new one by them.
    const back = () => boot().then(() => router.replace("/tailscale"));
    if (!host || (v && v !== "1")) {
      void back();
      return;
    }
    pair({ host, via: "qr" })
      .then(() => {
        track("mac paired", { via: "qr" });
        reachAll();
        router.replace("/designs");
      })
      .catch((err) => {
        setError(pairMessage(err, host.split(".")[0]!));
        setTimeout(back, 2_500);
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
