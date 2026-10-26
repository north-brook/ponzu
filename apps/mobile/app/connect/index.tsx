import { router } from "expo-router";
import type { ReactNode } from "react";
import { Linking, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import {
  Card,
  ConnectLayout,
  OtherTile,
  PillButton,
  TextButton,
} from "../../components/connect-layout";
import { Laptop, QR, SliceMark, Swap } from "../../components/icons";
import { useTheme } from "../../lib/theme";
import { brand } from "../../lib/tokens";

/**
 * Scan the code on your Mac (the onboarding design's 3), first launch's
 * second step: where Pair iPhone… is, drawn as the Mac's menu bar with
 * Ponzu's menu open on it, and three numbered steps to get there. Scan the
 * code opens the camera (connect/scan.tsx), which pairs and lands on Designs.
 */
export default function Connect() {
  const { color } = useTheme();
  const bold = { fontWeight: "600" as const };
  return (
    <ConnectLayout
      testID="connect"
      other={
        <OtherTile>
          <Laptop size={32} color={color.ink} width={1.6} />
        </OtherTile>
      }
      link={<Swap color={color.faint} />}
      title="Scan the code on your Mac."
      actions={
        <>
          <PillButton
            label="Scan the code"
            icon={<QR color={color.bg} />}
            onPress={() => router.push("/connect/scan")}
            testID="scan"
          />
          <TextButton
            label="No Ponzu on your Mac? Get it at ponzu.design"
            onPress={() => Linking.openURL("https://ponzu.design")}
          />
        </>
      }
    >
      <Card style={{ marginTop: 24 }}>
        <MenuBar />
        <Instruction n={1}>
          Open <Text style={bold}>Ponzu</Text> on your Mac
        </Instruction>
        <Instruction n={2}>
          Click <Text style={bold}>Ponzu</Text> in the menu bar, top left
        </Instruction>
        <Instruction n={3} last>
          Choose <Text style={bold}>Pair iPhone…</Text>
        </Instruction>
      </Card>
    </ConnectLayout>
  );
}

function Instruction({ n, last, children }: { n: number; last?: boolean; children: ReactNode }) {
  const { color } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: color.hairline,
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 999,
          backgroundColor: color.chip,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 13, color: color.ink }}>
          {n}
        </Text>
      </View>
      <Text
        style={{ flex: 1, fontFamily: "Inter", fontSize: 15, lineHeight: 20.25, color: color.ink }}
      >
        {children}
      </Text>
    </View>
  );
}

/**
 * The Mac's desktop as the site draws it (apps/web's `.stage`): yuzu with the big slice in ink
 * at 12% on light; soy with the slice in yuzu at 10% on dark. The slice's color here is that
 * mix, made solid. The menus follow the phone's theme, as a Mac's follow its own.
 */
const DESK = {
  light: {
    desk: brand.yuzu,
    slice: "#e2b21c",
    ink: "#111110",
    bar: "rgba(255,251,238,0.5)",
    chosen: "rgba(17,17,16,0.12)",
    menu: "rgba(250,249,246,0.96)",
    rule: "rgba(17,17,16,0.1)",
    shadow: "0 0 0 0.5px rgba(0,0,0,0.18), 0 10px 28px rgba(90,60,0,0.3)",
  },
  dark: {
    desk: "#1d1a13",
    slice: "#342b14",
    ink: "#f4f3ef",
    bar: "rgba(20,18,14,0.55)",
    chosen: "rgba(255,255,255,0.16)",
    menu: "rgba(40,38,34,0.96)",
    rule: "rgba(255,255,255,0.12)",
    shadow: "0 0 0 0.5px rgba(255,255,255,0.14), 0 10px 28px rgba(0,0,0,0.5)",
  },
} as const;
/** The highlighted menu item: macOS's own blue. */
const PICK = "#0a84ff";
const APPLE =
  "M11.6 9c0-2 1.7-3 1.8-3-1-1.4-2.5-1.6-3-1.6-1.3-.1-2.5.7-3.1.7-.7 0-1.7-.7-2.7-.7C3.2 4.4 1.9 5.2 1.2 6.5c-1.5 2.6-.4 6.4 1 8.5.7 1 1.5 2.2 2.6 2.1 1 0 1.4-.7 2.7-.7s1.6.7 2.7.6c1.1 0 1.8-1 2.5-2 .8-1.2 1.1-2.3 1.1-2.4 0 0-2.2-.8-2.2-3.6zM9.6 3c.6-.7 1-1.7.9-2.6-.8 0-1.8.5-2.4 1.2-.5.6-1 1.6-.9 2.5.9.1 1.8-.4 2.4-1.1z";

/** The Mac's menu bar on its desktop, Ponzu's menu open with Pair iPhone… picked. */
function MenuBar() {
  const { scheme } = useTheme();
  const mac = DESK[scheme];
  const menuText = { fontSize: 12, color: mac.ink };
  return (
    <View
      accessibilityLabel="On your Mac, the Ponzu menu in the menu bar, with Pair iPhone… in it"
      accessible
      style={{ height: 150, backgroundColor: mac.desk, overflow: "hidden" }}
    >
      <View style={{ position: "absolute", right: -90, top: -100 }}>
        <SliceMark size={300} color={mac.slice} />
      </View>
      <View
        style={{
          height: 26,
          flexDirection: "row",
          alignItems: "center",
          gap: 14,
          paddingHorizontal: 12,
          backgroundColor: mac.bar,
        }}
      >
        <Svg width={11} height={13} viewBox="0 0 14 17">
          <Path d={APPLE} fill={mac.ink} />
        </Svg>
        <Text
          style={{
            ...menuText,
            fontWeight: "700",
            paddingVertical: 3,
            paddingHorizontal: 7,
            marginHorizontal: -7,
            borderRadius: 5,
            overflow: "hidden",
            backgroundColor: mac.chosen,
          }}
        >
          Ponzu
        </Text>
        {["File", "Edit", "View", "Window"].map((m) => (
          <Text key={m} style={menuText}>
            {m}
          </Text>
        ))}
      </View>
      <View
        style={{
          position: "absolute",
          left: 30,
          top: 28,
          width: 168,
          paddingVertical: 4,
          borderRadius: 9,
          backgroundColor: mac.menu,
          boxShadow: mac.shadow,
        }}
      >
        <MenuItem label="About Ponzu" ink={mac.ink} />
        <MenuItem label="Check for Updates…" ink={mac.ink} />
        <MenuItem label="Pair iPhone…" ink={mac.ink} picked />
        <View
          style={{ height: 1, marginVertical: 4, marginHorizontal: 9, backgroundColor: mac.rule }}
        />
        <MenuItem label="Services" ink={mac.ink} />
      </View>
    </View>
  );
}

function MenuItem({ label, ink, picked }: { label: string; ink: string; picked?: boolean }) {
  return (
    <View
      style={{
        height: 22,
        justifyContent: "center",
        paddingHorizontal: 10,
        marginHorizontal: 4,
        borderRadius: 5,
        backgroundColor: picked ? PICK : undefined,
      }}
    >
      <Text style={{ fontSize: 12, color: picked ? "#ffffff" : ink }}>{label}</Text>
    </View>
  );
}
