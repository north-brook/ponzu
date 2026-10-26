import { router } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Linking, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Card,
  ConnectLayout,
  OtherTile,
  PillButton,
  TextButton,
} from "../components/connect-layout";
import { AlertCircle, Check, Laptop, Swap, TailscaleMark } from "../components/icons";
import { reachAll, useMacs } from "../lib/reach";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";
import { useTailnet } from "../lib/use-tailnet";

/** Tailscale in the App Store, when the app isn't installed. */
const TAILSCALE_STORE = "https://apps.apple.com/app/tailscale/id1470499037";
/** How long "Checking this iPhone…" shows first, so the check is seen to happen. */
const CHECKING = 700;
/** How long the green check shows before first launch moves on to the code. */
const ON_FOR = 900;
/** Tailscale is on: the green of the Mac's pairing dialog. */
const ON = "#2fa36b";

/**
 * Tailscale (the onboarding design's 2): this iPhone isn't on a tailnet.
 * It looks at its own interfaces for Tailscale's address
 * (lib/use-tailnet.ts), again every second and on coming back from the
 * Tailscale app, and says what it found: checking, or not on yet.
 *
 * First launch comes here only when Tailscale is off; once it's on, the row
 * turns green for a beat and the code on your Mac follows by itself
 * (connect/index.tsx). "Already on? Continue" goes on anyway (or, for a
 * paired phone, asks its Macs again), should the check ever be wrong. A paired phone whose Macs can't be reached at all
 * lands here too; once Tailscale is on it asks the Macs again and goes where
 * they say.
 */
export default function Tailscale() {
  const { color } = useTheme();
  const [why, setWhy] = useState(false);
  const { macs, reaching, overall } = useMacs();
  // Fixed on arrival: the Macs a pairing adds later don't make this the paired phone's screen.
  const [first] = useState(() => macs.length === 0);
  const found = useTailnet();
  const [looked, setLooked] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLooked(true), CHECKING);
    return () => clearTimeout(t);
  }, []);
  const state = looked ? found : "checking";
  // First launch moves on by itself once Tailscale is on, so only the row changes for it.
  const on = state === "on" && !first;

  useEffect(() => {
    if (state !== "on") return;
    if (!first) {
      reachAll();
      return;
    }
    const t = setTimeout(() => router.replace("/connect"), ON_FOR);
    return () => clearTimeout(t);
  }, [first, state]);
  useEffect(() => {
    if (first) return;
    if (overall.state === "answer") router.replace("/designs");
    else if (overall.state === "asleep") router.replace("/asleep");
  }, [first, overall.state]);

  const open = async () => {
    try {
      await Linking.openURL("tailscale://");
    } catch {
      await Linking.openURL(TAILSCALE_STORE);
    }
  };
  const next = () => {
    if (first) router.replace("/connect");
    else reachAll();
  };
  const whyButton = <TextButton label="Why Tailscale?" onPress={() => setWhy(true)} />;
  return (
    <>
      <ConnectLayout
        testID="tailscale"
        other={
          <OtherTile
            style={{ backgroundColor: "#141414", boxShadow: "0 0 0 1px rgba(255,255,255,0.08)" }}
          >
            <TailscaleMark size={36} />
          </OtherTile>
        }
        link={<Swap color={color.faint} />}
        title={on ? "Tailscale is on." : "Turn on Tailscale on this iPhone."}
        body="Ponzu talks straight to your Macs over your tailnet. No account, and your designs never pass through a server."
        actions={
          on ? (
            <>
              <PillButton
                label="Try again"
                icon={reaching ? <Juice size={20} color={color.bg} /> : undefined}
                onPress={next}
                testID="tailscale-continue"
              />
              {whyButton}
            </>
          ) : (
            <>
              <PillButton
                label="Open Tailscale"
                tone="tailscale"
                icon={<TailscaleMark size={20} />}
                onPress={open}
                testID="open-tailscale"
              />
              {state !== "checking" ? (
                <TextButton
                  label="Already on? Continue"
                  onPress={next}
                  testID="tailscale-continue"
                />
              ) : (
                whyButton
              )}
            </>
          )
        }
      >
        <Card style={{ marginTop: 28 }}>
          <Row
            icon={
              state === "checking" ? (
                <Tile color={color.chip}>
                  <Juice size={18} color={color.muted} />
                </Tile>
              ) : state === "on" ? (
                <Tile color={ON}>
                  <Check size={18} color="#ffffff" width={2.6} />
                </Tile>
              ) : (
                <Tile color={color.chip}>
                  <AlertCircle color={color.muted} />
                </Tile>
              )
            }
            title={
              state === "checking"
                ? "Checking this iPhone…"
                : state === "on"
                  ? "Tailscale is on"
                  : state === "off"
                    ? "Tailscale isn't on yet"
                    : "Turn on Tailscale"
            }
            detail={
              state === "checking"
                ? "Looking for Tailscale's connection"
                : state === "on"
                  ? "This iPhone is on your tailnet"
                  : "Turn it on in the Tailscale app"
            }
            testID={`tailscale-${state}`}
            divider
          />
          <Row
            icon={
              <Tile color={color.chip}>
                <Laptop size={18} color={color.ink} width={1.8} />
              </Tile>
            }
            title="Your Mac needs it too"
            detail="Signed in to the same Tailscale account"
          />
        </Card>
      </ConnectLayout>
      <WhySheet open={why} onClose={() => setWhy(false)} />
    </>
  );
}

function Tile({ color, children }: { color: string; children: ReactNode }) {
  return (
    <View
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </View>
  );
}

function Row({
  icon,
  title,
  detail,
  divider,
  testID,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  divider?: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        gap: 14,
        alignItems: "center",
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: color.hairline,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontFamily: "Inter",
            fontWeight: "600",
            fontSize: 15,
            lineHeight: 20.25,
            color: color.ink,
          }}
        >
          {title}
        </Text>
        <Text style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18.2, color: color.muted }}>
          {detail}
        </Text>
      </View>
    </View>
  );
}

/** "Why Tailscale?": the design notes' answer, in a small sheet. */
function WhySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const p = { fontFamily: "Inter", fontSize: 16, lineHeight: 24, color: color.muted };
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" />
      <View
        style={{
          marginHorizontal: 8,
          marginBottom: insets.bottom ? 8 : 0,
          padding: 24,
          paddingTop: 10,
          paddingBottom: 32,
          borderRadius: 38,
          backgroundColor: color.card,
          boxShadow: `0 -1px 0 ${color.hairline}, 0 -12px 40px rgba(0,0,0,0.12)`,
          gap: 14,
        }}
      >
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 5,
            borderRadius: 3,
            backgroundColor: color.chip,
          }}
        />
        <Text
          style={{
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: 24,
            letterSpacing: -0.03 * 24,
            color: color.ink,
          }}
        >
          Why Tailscale?
        </Text>
        <Text style={p}>
          Ponzu has no accounts and no servers of its own. Your iPhone talks straight to the Ponzu
          on each of your Macs, over your tailnet, so your designs never leave your devices.
        </Text>
        <Text style={p}>
          Tailscale already knows which devices are yours. Each Mac answers only your own devices,
          and the connection is encrypted end to end.
        </Text>
        <PillButton label="Done" tone="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}
