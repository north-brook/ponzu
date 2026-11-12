import { useSessionState } from "@ponzu/client/react";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { backend } from "../lib/cloud/backend";
import { useSignOut } from "../lib/cloud/use-sign-out";
import { thud } from "../lib/haptics";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";

/**
 * Settings, a sheet from the lockup. For now, the account: who is signed in, and Sign out. The
 * workspaces, notifications, read-only usage and Delete account join it with their slices.
 */
export default function Settings() {
  const { color, shadow } = useTheme();
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
      <Text
        style={{
          marginTop: 12,
          fontFamily: "Inter",
          fontWeight: "600",
          fontSize: 13,
          color: color.muted,
        }}
      >
        Account
      </Text>
      <View
        style={{
          borderRadius: 16,
          backgroundColor: color.card,
          boxShadow: shadow.board,
          overflow: "hidden",
        }}
      >
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
      </View>
    </ScrollView>
  );
}
