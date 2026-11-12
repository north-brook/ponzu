import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import type { ShownWorkspace } from "../lib/cloud/canvases";
import { useCloud } from "../lib/cloud/query";
import { usageView } from "../lib/cloud/usage";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";
import { SectionCard, SectionTitle } from "./settings-parts";

/**
 * Usage this period for the workspace in view, read only: the total, the line under it (the
 * Mac's own words, from the shared billing rules) and the bar. Nothing here changes the cap,
 * adds a card or points to anywhere to pay: that stays on the Mac, and the phone never says so.
 */
export function SettingsUsage({ workspace }: { workspace: ShownWorkspace | null }) {
  const { color } = useTheme();
  const cloud = useCloud();
  const usage = useQuery({
    ...cloud.queries.usage(workspace?.id ?? ""),
    enabled: workspace !== null,
  });
  if (!workspace || !usage.data) return null;
  const view = usageView(usage.data, workspace);
  return (
    <>
      <SectionTitle>Usage</SectionTitle>
      <SectionCard testID="settings-usage">
        <View style={{ padding: 14, gap: 6 }}>
          <Text
            testID="usage-headline"
            style={{
              fontFamily: "Funnel Display",
              fontWeight: "700",
              fontSize: 26,
              lineHeight: 30,
              letterSpacing: -0.03 * 26,
              color: color.ink,
            }}
          >
            {view.headline}
          </Text>
          <Text
            testID="usage-line"
            style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18, color: color.muted }}
          >
            {view.line}
          </Text>
          <View
            testID="usage-bar"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              marginTop: 6,
              height: 6,
              borderRadius: 3,
              flexDirection: "row",
              overflow: "hidden",
              backgroundColor: color.chip,
            }}
          >
            <View style={{ flex: view.bar.free, backgroundColor: brand.yuzu }} />
            <View style={{ flex: view.bar.billed, backgroundColor: color.ink }} />
            <View style={{ flex: Math.max(0, 1 - view.bar.free - view.bar.billed) }} />
          </View>
        </View>
      </SectionCard>
    </>
  );
}
