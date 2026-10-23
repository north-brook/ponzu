import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import {
  Card,
  ConnectLayout,
  OtherTile,
  PillButton,
  TextButton,
} from "../../components/connect-layout";
import { Laptop, QR, Swap } from "../../components/icons";
import { type NearbyMac, useNearbyMacs } from "../../lib/bonjour";
import { fetchCatalog } from "../../lib/catalog";
import { PORT } from "../../lib/mac";
import { fetchInfo, pairMessage, usePair } from "../../lib/macs";
import { reachAll } from "../../lib/reach";
import { track } from "../../lib/telemetry";
import { useTheme } from "../../lib/theme";
import { brand, EASE_OUT } from "../../lib/tokens";

/**
 * Connect a Mac (Connect › 4 Mac found on Wi-Fi, 4b Nothing on this Wi-Fi):
 * Macs running Ponzu on this Wi-Fi, found by Bonjour, each with Connect; or
 * the code from Ponzu › Pair iPhone… on the Mac. The first browse raises
 * iOS's local network prompt (3 Allow local network is the system's).
 */
export default function Connect() {
  const { color } = useTheme();
  const nearby = useNearbyMacs();
  const [error, setError] = useState<string | null>(null);
  const nothing = nearby.settled;
  const scan = () => router.push("/connect/scan");
  return (
    <ConnectLayout
      testID="connect"
      other={
        <OtherTile>
          <Laptop size={32} color={color.ink} width={1.6} />
        </OtherTile>
      }
      link={<Swap color={color.faint} />}
      title="Connect a Mac running Ponzu."
      body="Once one Mac is connected, Ponzu finds your others on its own."
      actions={
        <>
          <PillButton
            label="Scan the code on your Mac"
            tone={nothing ? "primary" : "secondary"}
            icon={<QR color={nothing ? color.bg : color.ink} />}
            onPress={scan}
            testID="scan"
          />
          <TextButton label="On your Mac: Ponzu › Pair iPhone…" />
        </>
      }
    >
      <View style={{ marginTop: 28, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
          <Ping on={!nothing} />
          <Text
            style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 13, color: color.muted }}
          >
            On this Wi-Fi
          </Text>
        </View>
        <Card>
          {nearby.macs.map((m, i) => (
            <Found key={m.host} mac={m} last={i === nearby.macs.length - 1} onError={setError} />
          ))}
          {nearby.macs.length === 0 &&
            (nothing ? (
              <NothingHere denied={nearby.state === "denied"} />
            ) : (
              <View style={{ height: 68, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color={color.faint} />
              </View>
            ))}
        </Card>
        {error && (
          <Text
            style={{
              fontFamily: "Inter",
              fontSize: 14,
              lineHeight: 20,
              color: color.muted,
              paddingHorizontal: 4,
            }}
          >
            {error}
          </Text>
        )}
      </View>
    </ConnectLayout>
  );
}

/** The yuzu dot that pings while the phone looks; grey once it's done looking. */
function Ping({ on }: { on: boolean }) {
  const { color } = useTheme();
  const t = useSharedValue(0);
  const still = useReducedMotion();
  useEffect(() => {
    if (!on || still) return;
    t.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.bezier(...EASE_OUT) }), -1);
  }, [on, still]);
  const ring = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - t.value),
    transform: [{ scale: 1 + 1.6 * t.value }],
  }));
  const dot = { position: "absolute" as const, inset: 0, borderRadius: 999 };
  return (
    <View style={{ width: 8, height: 8 }}>
      {on && <Animated.View style={[dot, { backgroundColor: brand.yuzu }, ring]} />}
      <View style={[dot, { backgroundColor: on ? brand.yuzu : color.faint }]} />
    </View>
  );
}

/** A Mac on this Wi-Fi: its name, Ponzu's version and design count, and Connect. */
function Found({
  mac,
  last,
  onError,
}: {
  mac: NearbyMac;
  last: boolean;
  onError: (message: string | null) => void;
}) {
  const { color } = useTheme();
  // Not saved yet, so asked by host: the queries under "nearby" aren't kept.
  const address = { dns: mac.host, address: `${mac.host}:${PORT}` };
  const info = useQuery({
    queryKey: ["nearby", mac.host, "info"],
    queryFn: () => fetchInfo(`http://${address.address}`, 4_000),
  });
  const designs = useQuery({
    queryKey: ["nearby", mac.host, "catalog"],
    queryFn: () => fetchCatalog(address),
    enabled: info.isSuccess,
    select: (c) => c.files.length,
  });
  const pair = usePair();
  const busy = pair.isPending;
  const connect = async () => {
    onError(null);
    try {
      await pair.mutateAsync({ host: mac.host, via: "bonjour" });
      track("mac paired", { via: "bonjour" });
      reachAll();
      router.replace("/designs");
    } catch (err) {
      onError(pairMessage(err, mac.name));
    }
  };
  const detail = info.data
    ? `Ponzu ${info.data.version.replace(/\.0$/, "")}${designs.data !== undefined ? ` · ${designs.data} designs` : ""}`
    : "Ponzu";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: color.hairline,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          backgroundColor: color.chip,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Laptop size={22} color={color.ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 16,
            lineHeight: 21.6,
            color: color.ink,
          }}
        >
          {mac.name}
        </Text>
        <Text
          numberOfLines={1}
          style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18.2, color: color.muted }}
        >
          {detail}
        </Text>
      </View>
      <Pressable
        onPress={connect}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Connect ${mac.name}`}
        style={({ pressed }) => ({
          height: 34,
          paddingHorizontal: 14,
          borderRadius: 999,
          backgroundColor: color.ink,
          justifyContent: "center",
          opacity: busy ? 0.6 : pressed ? 0.8 : 1,
        })}
      >
        {busy ? (
          <ActivityIndicator color={color.bg} size="small" />
        ) : (
          <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 14, color: color.bg }}>
            Connect
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/** 4b: nothing found, or local network access refused. */
function NothingHere({ denied }: { denied: boolean }) {
  const { color } = useTheme();
  return (
    <View style={{ padding: 16, flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          backgroundColor: color.chip,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Laptop size={18} color={color.muted} width={1.8} />
      </View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text
          style={{
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 15,
            lineHeight: 20.25,
            color: color.ink,
          }}
        >
          {denied ? "Ponzu can't look on this Wi-Fi" : "No Mac on this Wi-Fi"}
        </Text>
        <Text style={{ fontFamily: "Inter", fontSize: 14, lineHeight: 20.3, color: color.muted }}>
          {denied ? "Local network access is off for Ponzu in Settings. " : ""}On your Mac, open
          Ponzu and choose{" "}
          <Text style={{ color: color.ink, fontWeight: "600" }}>Ponzu › Pair iPhone…</Text>, then
          scan the code.
        </Text>
      </View>
    </View>
  );
}
