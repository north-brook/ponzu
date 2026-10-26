import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../lib/theme";
import { AppTile } from "./chrome";
import { HandoffRise, HandoffTarget } from "./handoff";

/**
 * The Connect pages' frame: two marks joined by a link, a display title,
 * body text and the screen's own content (the design's Content), then the
 * actions pinned to the bottom, 58pt above the screen's edge (Actions). One
 * column that scrolls when the text is large; the actions follow the content
 * then, instead of covering it.
 *
 * Coming from the launch screen, the yuzu tile is where the launch's yuzu
 * lands, and the rest rises in after it (components/handoff.tsx).
 */
export function ConnectLayout({
  other,
  link,
  title,
  body,
  children,
  actions,
  testID,
}: {
  /** The right-hand mark's tile. */
  other: ReactNode;
  link: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
  actions: ReactNode;
  testID?: string;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 56 }}
        bounces={false}
      >
        <View style={{ flexGrow: 1, paddingHorizontal: 28, paddingBottom: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <HandoffTarget kind="tile" size={64}>
              <AppTile />
            </HandoffTarget>
            <HandoffRise
              kind="tile"
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
            >
              {link}
              {other}
            </HandoffRise>
          </View>
          <HandoffRise kind="tile">
            <Text
              style={{
                marginTop: 28,
                fontFamily: "Funnel Display",
                fontWeight: "700",
                fontSize: 34,
                lineHeight: 34 * 1.08,
                letterSpacing: -0.03 * 34,
                color: color.ink,
              }}
            >
              {title}
            </Text>
            {body && (
              <Text
                style={{
                  marginTop: 14,
                  fontFamily: "Inter",
                  fontSize: 17,
                  lineHeight: 17 * 1.5,
                  color: color.muted,
                }}
              >
                {body}
              </Text>
            )}
            {children}
          </HandoffRise>
        </View>
        <HandoffRise kind="tile" style={{ paddingHorizontal: 20, paddingBottom: 58, gap: 10 }}>
          {actions}
        </HandoffRise>
      </ScrollView>
    </View>
  );
}

/** The 64pt tile on the right of the marks. */
export function OtherTile({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { color } = useTheme();
  return (
    <View
      style={[
        {
          width: 64,
          height: 64,
          borderRadius: 16,
          backgroundColor: color.chip,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A grouped list on a card: rows split by hairlines. */
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { color, shadow } = useTheme();
  return (
    <View
      style={[
        {
          borderRadius: 16,
          backgroundColor: color.card,
          boxShadow: shadow.board,
          overflow: "hidden",
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A 54pt pill button: ink (primary), chip (secondary), or Tailscale's own black. */
export function PillButton({
  label,
  icon,
  onPress,
  tone = "primary",
  disabled,
  testID,
}: {
  label: string;
  icon?: ReactNode;
  onPress: () => void;
  tone?: "primary" | "secondary" | "tailscale";
  disabled?: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  const bg = tone === "primary" ? color.ink : tone === "secondary" ? color.chip : "#141414";
  const fg = tone === "primary" ? color.bg : tone === "secondary" ? color.ink : "#ffffff";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      style={({ pressed }) => ({
        height: 54,
        borderRadius: 999,
        backgroundColor: bg,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      {icon}
      <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 17, color: fg }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The quiet 44pt text action under the primary button. */
export function TextButton({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress?: () => void;
  testID?: string;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      testID={testID}
      accessibilityRole={onPress ? "button" : "text"}
      style={({ pressed }) => ({
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          fontFamily: "Inter",
          fontWeight: "500",
          fontSize: 15,
          color: color.muted,
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
