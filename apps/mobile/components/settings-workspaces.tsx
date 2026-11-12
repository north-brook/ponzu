import { Pressable, Text, View } from "react-native";
import type { ShownWorkspace } from "../lib/cloud/canvases";
import { select } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { Check } from "./icons";
import { SectionCard, SectionTitle } from "./settings-parts";

/**
 * Settings' first section, when the person is in more than one workspace: each of them, the one
 * in view ticked. Picking one shows its canvases at once, here and on the next launch.
 */
export function SettingsWorkspaces({
  workspaces,
  current,
  onChoose,
}: {
  workspaces: readonly ShownWorkspace[];
  current: string | null;
  onChoose: (id: string) => void;
}) {
  const { color } = useTheme();
  if (workspaces.length < 2) return null;
  return (
    <>
      <SectionTitle>Workspaces</SectionTitle>
      <SectionCard testID="settings-workspaces">
        {workspaces.map((workspace, i) => {
          const on = workspace.id === current;
          return (
            <Pressable
              key={workspace.id}
              testID={`workspace-${workspace.id}`}
              accessibilityRole="button"
              accessibilityLabel={workspace.name}
              accessibilityState={{ selected: on }}
              onPress={() => {
                if (on) return;
                select();
                onChoose(workspace.id);
              }}
              style={({ pressed }) => ({
                minHeight: 48,
                paddingHorizontal: 14,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: color.hairline,
                backgroundColor: pressed ? color.chip : undefined,
              })}
            >
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  fontFamily: "Inter",
                  fontWeight: on ? "600" : "400",
                  fontSize: 15,
                  color: color.ink,
                }}
              >
                {workspace.name}
              </Text>
              <View style={{ width: 16 }}>{on && <Check color={color.ink} />}</View>
            </Pressable>
          );
        })}
      </SectionCard>
    </>
  );
}
