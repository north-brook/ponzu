import { useSessionState } from "@ponzu/client/react";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SectionCard, SectionTitle } from "../components/settings-parts";
import { SettingsUsage } from "../components/settings-usage";
import { SettingsWorkspaces } from "../components/settings-workspaces";
import { backend } from "../lib/cloud/backend";
import { useWorkspaces } from "../lib/cloud/canvases";
import { useSignOut } from "../lib/cloud/use-sign-out";
import { thud } from "../lib/haptics";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";

/**
 * Settings, a sheet from the lockup: the workspaces (when there are more than one), the account
 * (who is signed in, and Sign out), and the workspace in view's usage, read only. Notifications
 * and Delete account join it with their slices.
 */
export default function Settings() {
  const { color } = useTheme();
  const { workspaces, workspace, choose } = useWorkspaces();
  const state = useSessionState(backend.session);
  const signOut = useSignOut();
  const [leaving, setLeaving] = useState(false);
  const once = useRef(false);
  const user = state.status === "signed_in" ? state.user : null;

  const leave = async () => {
    if (once.current) return;
    once.current = true;
    thud();
    setLeaving(true);
    await signOut();
  };

  return (
    <ScrollView
      testID="settings"
      style={{ flex: 1, backgroundColor: color.bg }}
      contentContainerStyle={{ padding: 20, gap: 12 }}
    >
      <Text
        accessibilityRole="header"
        style={{
          fontFamily: "Funnel Display",
          fontWeight: "700",
          fontSize: 26,
          lineHeight: 28,
          letterSpacing: -0.03 * 26,
          color: color.ink,
        }}
      >
        Settings
      </Text>
      <SettingsWorkspaces
        workspaces={workspaces ?? []}
        current={workspace?.id ?? null}
        onChoose={choose}
      />
      <SectionTitle>Account</SectionTitle>
      <SectionCard>
        {user && (
          <View
            testID="settings-account"
            accessible
            accessibilityLabel={`Signed in as ${user.name ?? user.githubLogin}, ${user.githubLogin} on GitHub`}
            style={{
              paddingVertical: 12,
              paddingHorizontal: 14,
              borderBottomWidth: 1,
              borderBottomColor: color.hairline,
            }}
          >
            <Text
              style={{
                fontFamily: "Inter",
                fontWeight: "600",
                fontSize: 15,
                lineHeight: 20,
                color: color.ink,
              }}
            >
              {user.name ?? user.githubLogin}
            </Text>
            <Text style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18, color: color.muted }}>
              @{user.githubLogin}
            </Text>
          </View>
        )}
        <Pressable
          testID="settings-sign-out"
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          accessibilityState={{ busy: leaving, disabled: leaving }}
          disabled={leaving}
          onPress={() => void leave()}
          style={({ pressed }) => ({
            paddingVertical: 14,
            paddingHorizontal: 14,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text
            style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 15, color: color.danger }}
          >
            Sign out
          </Text>
          {leaving && <Juice size={16} color={color.faint} />}
        </Pressable>
      </SectionCard>
      <SettingsUsage workspace={workspace} />
    </ScrollView>
  );
}
