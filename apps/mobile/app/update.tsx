import { Linking, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SliceMark } from "../components/icons";
import { PillButton } from "../components/step";
import { useTheme } from "../lib/theme";

/** Where an iPhone gets the current Ponzu: the site sends it on to TestFlight or the App Store. */
const GET_PONZU = "https://ponzu.design/iphone";

/**
 * The API refused this version (426, the session's `too_old`): nothing else will work, so this
 * is the only screen, until the person updates. An over-the-air update may fix it on the next
 * launch by itself; a binary that is too old needs the store.
 */
export default function Update() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View testID="update" style={{ flex: 1, backgroundColor: color.bg }}>
      <View style={{ position: "absolute", left: 32, right: 32, top: 250, alignItems: "center" }}>
        <SliceMark size={72} color={color.ink} />
        <Text
          accessibilityRole="header"
          style={{
            marginTop: 36,
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: 30,
            lineHeight: 33,
            letterSpacing: -0.02 * 30,
            color: color.ink,
            textAlign: "center",
          }}
        >
          Update Ponzu
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
          This version of Ponzu is too old. Update it to keep going.
        </Text>
      </View>
      <View
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          bottom: Math.max(58, insets.bottom + 24),
        }}
      >
        <PillButton
          testID="update-open"
          label="Update Ponzu"
          onPress={() => void Linking.openURL(GET_PONZU).catch(() => {})}
        />
      </View>
    </View>
  );
}
