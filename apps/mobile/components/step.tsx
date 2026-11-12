import { Image } from "expo-image";
import type { ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SETUP } from "../lib/copy";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";

/*
 * What every setup step shares, so nothing moves between them (onboarding 2.5, as the Mac's
 * cloud/setup/step.tsx): the progress bars, the title and its line, the step's own card, and
 * its actions pinned to the bottom, 58pt above the screen's edge. One column that scrolls when
 * the text is large or the keyboard is up; the actions follow the content then.
 */

export function StepLayout({
  progress,
  of = 2,
  title,
  body,
  children,
  actions,
  testID,
}: {
  /** This step's place, from 1. */
  progress: number;
  of?: number;
  title: string;
  body: string;
  children?: ReactNode;
  actions?: ReactNode;
  testID?: string;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + 40 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <View style={{ flexGrow: 1, paddingHorizontal: 20, paddingBottom: 24 }}>
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={SETUP.progress(progress, of)}
            accessibilityValue={{ min: 1, max: of, now: progress }}
            style={{ flexDirection: "row", gap: 6, alignSelf: "center" }}
          >
            {Array.from({ length: of }, (_, i) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: the bars are fixed and in order.
                key={i}
                style={{
                  width: 28,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: i < progress ? color.ink : color.chip,
                }}
              />
            ))}
          </View>
          <Text
            accessibilityRole="header"
            style={{
              marginTop: 40,
              fontFamily: "Funnel Display",
              fontWeight: "700",
              fontSize: 30,
              lineHeight: 33,
              letterSpacing: -0.02 * 30,
              color: color.ink,
              textAlign: "center",
            }}
          >
            {title}
          </Text>
          <Text
            style={{
              marginTop: 12,
              fontFamily: "Inter",
              fontSize: 16,
              lineHeight: 24,
              color: color.muted,
              textAlign: "center",
            }}
          >
            {body}
          </Text>
          <View style={{ marginTop: 28 }}>{children}</View>
        </View>
        {actions ? (
          <View style={{ paddingHorizontal: 20, paddingBottom: Math.max(58, insets.bottom + 24) }}>
            {actions}
          </View>
        ) : null}
      </ScrollView>
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

/** One row on a card: a 32pt mark, a title over a line, and what can be done on the right. */
export function SetupRow({
  mark,
  title,
  line,
  children,
  last = false,
  testID,
}: {
  mark: ReactNode;
  title: string;
  line?: string | null;
  children?: ReactNode;
  /** The last row on its card has no hairline under it. */
  last?: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: color.hairline,
      }}
    >
      {mark}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 16, color: color.ink }}
        >
          {title}
        </Text>
        {line ? (
          <Text style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18, color: color.faint }}>
            {line}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** The 32pt tile a row's mark sits on. */
export function MarkTile({ children }: { children: ReactNode }) {
  const { color } = useTheme();
  return (
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
      {children}
    </View>
  );
}

/** An account's 32pt picture: round for a person, a rounded square for an organization. */
export function AccountMark({
  avatarUrl,
  login,
  personal,
}: {
  avatarUrl: string | null;
  login: string;
  personal: boolean;
}) {
  const { color } = useTheme();
  const radius = personal ? 16 : 8;
  if (avatarUrl) {
    return (
      <Image
        source={{ uri: avatarUrl }}
        accessibilityIgnoresInvertColors
        style={{ width: 32, height: 32, borderRadius: radius, backgroundColor: color.chip }}
      />
    );
  }
  return (
    <View
      style={{
        width: 32,
        height: 32,
        borderRadius: radius,
        backgroundColor: color.chip,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{ fontFamily: "Funnel Display", fontWeight: "700", fontSize: 15, color: color.ink }}
      >
        {login.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

/**
 * A row's own button: ink for the way the step wants, the chip for the others. Busy, it turns
 * the slice in its place and takes no second press; it is not a Cancel.
 */
export function RowButton({
  label,
  onPress,
  tone = "raised",
  busy = false,
  disabled = false,
  accessibilityLabel,
  testID,
}: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "raised";
  busy?: boolean;
  disabled?: boolean;
  /** What VoiceOver says, when the label alone doesn't say which row it is for. */
  accessibilityLabel?: string;
  testID?: string;
}) {
  const { color } = useTheme();
  const bg = tone === "primary" ? color.ink : color.chip;
  const fg = tone === "primary" ? color.bg : color.ink;
  return (
    <Pressable
      testID={testID}
      onPress={busy || disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ busy, disabled }}
      hitSlop={8}
      style={({ pressed }) => ({
        height: 32,
        minWidth: 72,
        paddingHorizontal: 14,
        borderRadius: 999,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : pressed && !busy ? 0.8 : 1,
      })}
    >
      {busy ? (
        <Juice size={15} color={fg} />
      ) : (
        <Text style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 14, color: fg }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** A 54pt pill button: ink (primary) or chip (secondary). Busy, it turns the slice. */
export function PillButton({
  label,
  icon,
  onPress,
  tone = "primary",
  disabled,
  busy = false,
  testID,
}: {
  label: string;
  icon?: ReactNode;
  onPress: () => void;
  tone?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  const bg = tone === "primary" ? color.ink : color.chip;
  const fg = tone === "primary" ? color.bg : color.ink;
  return (
    <Pressable
      onPress={busy ? undefined : onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy }}
      style={({ pressed }) => ({
        height: 54,
        borderRadius: 999,
        backgroundColor: bg,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        opacity: disabled ? 0.4 : pressed && !busy ? 0.8 : 1,
      })}
    >
      {busy ? <Juice size={20} color={fg} /> : icon}
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
  disabled,
  testID,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress || disabled}
      testID={testID}
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        minHeight: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
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

/** One line under the card: a notice, or a failure in the danger color. */
export function StepNote({
  children,
  tone = "muted",
  testID,
}: {
  children: string;
  tone?: "muted" | "danger";
  testID?: string;
}) {
  const { color } = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityLiveRegion="polite"
      accessibilityRole={tone === "danger" ? "alert" : "text"}
      style={{
        marginTop: 14,
        fontFamily: "Inter",
        fontSize: 13,
        lineHeight: 18,
        textAlign: "center",
        color: tone === "danger" ? color.danger : color.muted,
      }}
    >
      {children}
    </Text>
  );
}
