import { router } from "expo-router";
import { useEffect } from "react";
import { Text, View } from "react-native";
import {
  Card,
  ConnectLayout,
  OtherTile,
  PillButton,
  TextButton,
} from "../components/connect-layout";
import { Dashes, MacIcon, Moon, Refresh } from "../components/icons";
import { lastAnswered } from "../lib/files";
import { reachAll, useMacs } from "../lib/reach";
import { Juice } from "../lib/slice";
import { useTheme } from "../lib/theme";

/**
 * Your Macs aren't answering (Connect › R3): the phone reaches the tailnet
 * but no Mac's Ponzu replied, even after a knock on the wake port. Try again,
 * or show the designs from the cache.
 */
export default function Asleep() {
  const { color } = useTheme();
  const { macs, reaching, overall } = useMacs();
  useEffect(() => {
    if (overall.state === "answer") router.replace("/designs");
    else if (overall.state === "noTailnet") router.replace("/tailscale");
  }, [overall.state]);
  return (
    <ConnectLayout
      testID="asleep"
      other={
        <OtherTile>
          <Moon size={30} color={color.muted} width={1.8} />
        </OtherTile>
      }
      link={<Dashes color={color.faint} />}
      title="Your Macs aren't answering."
      body="Tailscale is on, but no Mac replied. They're probably asleep or off. If a Mac is awake, Ponzu starts on its own."
      actions={
        <>
          <PillButton
            label="Try again"
            icon={
              reaching ? (
                // The slice juicing in the icon's own slot: the button keeps its width.
                <Juice size={20} color={color.bg} />
              ) : (
                <Refresh color={color.bg} />
              )
            }
            disabled={reaching}
            onPress={() => reachAll()}
          />
          <TextButton
            label="Show designs from last time"
            onPress={() => router.replace("/designs")}
          />
        </>
      }
    >
      <Card style={{ marginTop: 32 }}>
        {macs.map((m, i) => (
          <View
            key={m.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderBottomWidth: i === macs.length - 1 ? 0 : 1,
              borderBottomColor: color.hairline,
            }}
          >
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                backgroundColor: color.chip,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <MacIcon kind={m.kind} size={22} color={color.muted} />
              <View
                style={{
                  position: "absolute",
                  right: -4,
                  bottom: -4,
                  width: 20,
                  height: 20,
                  borderRadius: 999,
                  backgroundColor: color.card,
                  alignItems: "center",
                  justifyContent: "center",
                  boxShadow: `0 0 0 1px ${color.hairline}`,
                }}
              >
                <Moon size={12} color={color.muted} />
              </View>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: "Inter",
                  fontWeight: "600",
                  fontSize: 16,
                  lineHeight: 21.6,
                  color: color.ink,
                }}
              >
                {m.name}
              </Text>
              <Text
                style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18.2, color: color.muted }}
              >
                {lastAnswered(m.lastAnsweredAt)}
              </Text>
            </View>
          </View>
        ))}
      </Card>
    </ConnectLayout>
  );
}
