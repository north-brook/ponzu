import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../lib/theme";

/** A settings section's quiet title, over its card. */
export function SectionTitle({ children }: { children: string }) {
  const { color } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        marginTop: 12,
        fontFamily: "Inter",
        fontWeight: "600",
        fontSize: 13,
        color: color.muted,
      }}
    >
      {children}
    </Text>
  );
}

/** The card a section's rows sit in. */
export function SectionCard({ children, testID }: { children: ReactNode; testID?: string }) {
  const { color, shadow } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        borderRadius: 16,
        borderCurve: "continuous",
        backgroundColor: color.card,
        boxShadow: shadow.board,
        overflow: "hidden",
      }}
    >
      {children}
    </View>
  );
}
