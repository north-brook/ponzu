import { useState } from "react";
import { Linking, Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Card,
  ConnectLayout,
  OtherTile,
  PillButton,
  TextButton,
} from "../components/connect-layout";
import { SliceMark, Swap, TailscaleMark } from "../components/icons";
import { reachAll } from "../lib/reach";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";

/** Tailscale in the App Store, when the app isn't installed. */
const TAILSCALE_STORE = "https://apps.apple.com/app/tailscale/id1470499037";

/**
 * Needs Tailscale (Connect › 2 Tailscale off): no Mac could be reached at
 * all, so the phone isn't on the tailnet. Open Tailscale, and come back:
 * coming back to the app asks every Mac again.
 */
export default function Tailscale() {
  const { color } = useTheme();
  const [why, setWhy] = useState(false);
  const open = async () => {
    try {
      await Linking.openURL("tailscale://");
    } catch {
      await Linking.openURL(TAILSCALE_STORE);
    }
  };
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
        title="Ponzu reaches your Macs through Tailscale."
        body="Your iPhone talks straight to the Ponzu on your Macs, over your tailnet. There's no account, and your designs never pass through a server."
        actions={
          <>
            <PillButton
              label="Open Tailscale"
              tone="tailscale"
              icon={<TailscaleMark size={20} />}
              onPress={open}
            />
            <TextButton label="Why Tailscale?" onPress={() => setWhy(true)} />
          </>
        }
      >
        <Card style={{ marginTop: 32 }}>
          <Step
            icon={
              <View style={[tile, { backgroundColor: "#141414" }]}>
                <TailscaleMark size={18} />
              </View>
            }
            title="Turn on Tailscale on this iPhone"
            detail="Same account as your Macs"
            divider
            onPress={() => reachAll()}
          />
          <Step
            icon={
              <View style={[tile, { backgroundColor: brand.yuzu }]}>
                <SliceMark size={20} color={brand.ink} />
              </View>
            }
            title="Install Ponzu on a Mac"
            detail="It runs in the background"
            onPress={() => Linking.openURL("https://ponzu.design")}
          />
        </Card>
      </ConnectLayout>
      <WhySheet open={why} onClose={() => setWhy(false)} />
    </>
  );
}

const tile = {
  width: 32,
  height: 32,
  borderRadius: 8,
  alignItems: "center" as const,
  justifyContent: "center" as const,
};

function Step({
  icon,
  title,
  detail,
  divider,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  divider?: boolean;
  onPress?: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 14,
        alignItems: "center",
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: color.hairline,
        opacity: pressed ? 0.7 : 1,
      })}
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
    </Pressable>
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
