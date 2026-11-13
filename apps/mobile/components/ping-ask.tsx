import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { PINGS } from "../lib/copy";
import { tick } from "../lib/haptics";
import { useTheme } from "../lib/theme";
import { Sheet } from "./sheet";
import { PillButton, TextButton } from "./step";

/**
 * The ask after the first comment sent from this phone (onboarding §4.12, board 4.12): would the
 * person like to hear back. Turn on notifications brings iOS's own prompt; Not now, or a swipe
 * down, keeps the phone quiet, and it asks once more after a comment a week on
 * (lib/push/ask.ts). Nothing here opens by itself at launch or in setup.
 */
export function PingAsk({
  onTurnOn,
  onNotNow,
  right,
}: {
  onTurnOn: () => Promise<void>;
  onNotNow: () => void;
  right?: number;
}) {
  const { color } = useTheme();
  const [busy, setBusy] = useState(false);
  const done = useRef(false);
  const once = (run: () => void) => {
    if (done.current) return;
    done.current = true;
    run();
  };
  return (
    <Sheet testID="ping-ask" onDismiss={() => once(onNotNow)} gap={10} right={right}>
      <View style={{ gap: 8, paddingTop: 4, paddingHorizontal: 6 }}>
        <Text
          accessibilityRole="header"
          style={{
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: 22,
            lineHeight: 26,
            color: color.ink,
          }}
        >
          {PINGS.ask.title}
        </Text>
        <Text style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 21, color: color.muted }}>
          {PINGS.ask.body}
        </Text>
      </View>
      <View style={{ gap: 2, paddingTop: 6 }}>
        <PillButton
          testID="ping-ask-turn-on"
          label={PINGS.ask.turnOn}
          busy={busy}
          onPress={() =>
            once(() => {
              tick();
              setBusy(true);
              void onTurnOn().finally(() => setBusy(false));
            })
          }
        />
        <TextButton
          testID="ping-ask-not-now"
          label={PINGS.ask.notNow}
          onPress={() => once(onNotNow)}
        />
      </View>
    </Sheet>
  );
}
