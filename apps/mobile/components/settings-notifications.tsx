import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState, Linking, Pressable, Switch, Text, View } from "react-native";
import { useWorkspaces } from "../lib/cloud/canvases";
import { useCloud } from "../lib/cloud/query";
import { PINGS } from "../lib/copy";
import { select } from "../lib/haptics";
import type { PingPermission } from "../lib/push/ask";
import { native } from "../lib/push/native";
import { devices, usePings } from "../lib/push/pings";
import { useTheme } from "../lib/theme";
import { SectionCard, SectionTitle } from "./settings-parts";

/**
 * Settings › Notifications on the phone (iPhone design §12): which events ping the person, in
 * the Mac's words and saved as flipped on any device, and this iPhone's own Pings. Shown only
 * while the API sends pings (`features.push`): until then there is nothing to turn on.
 */
export function SettingsNotifications() {
  const pings = usePings();
  if (!pings.on) return null;
  return <Notifications />;
}

function Notifications() {
  const { color } = useTheme();
  const cloud = useCloud();
  const pings = usePings();
  const { workspaces } = useWorkspaces();
  const answer = useQuery({ ...cloud.queries.notifications(), enabled: cloud.userId !== null });
  const setPings = useMutation(cloud.mutations.setPings());
  const setDevicePings = useMutation(cloud.mutations.setDevicePings());
  const [permission, setPermission] = useState<PingPermission | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  // What iOS says now, and this phone's device: again each time the app comes forward (the
  // person may have been to iOS Settings).
  useEffect(() => {
    let live = true;
    const read = () => {
      void native
        .permission()
        .then((p) => live && setPermission(p))
        .catch(() => {});
      if (cloud.userId) {
        void devices.read(cloud.userId).then((id) => live && setDeviceId(id));
      }
    };
    read();
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        read();
        void answer.refetch();
      }
    });
    return () => {
      live = false;
      app.remove();
    };
  }, [cloud.userId]);

  // A registration since (at launch, or Turn on) brings a new list: this phone may be on it.
  const listed = answer.data?.devices.map((d) => d.id).join(" ");
  useEffect(() => {
    if (!cloud.userId) return;
    let live = true;
    void devices.read(cloud.userId).then((id) => live && setDeviceId(id));
    return () => {
      live = false;
    };
  }, [listed, cloud.userId]);

  const data = answer.data;
  if (!data) return null;
  const team = (workspaces ?? []).some((w) => w.kind === "org");
  const events = team ? PINGS.events : PINGS.events.filter((e) => e.key !== "teammateComments");
  const mine = deviceId ? data.devices.find((d) => d.id === deviceId) : undefined;
  const blocked = permission === "denied" || mine?.blocked === true;

  return (
    <>
      <SectionTitle>{PINGS.section}</SectionTitle>
      <SectionCard testID="settings-notifications">
        <Label>{PINGS.settings.pingMeWhen}</Label>
        {events.map((event) => (
          <Row
            key={event.key}
            title={event.title}
            line={event.line}
            testID={`settings-ping-${event.key}`}
            on={data.prefs[event.key]}
            onChange={(on) => {
              select();
              setPings.mutate({ [event.key]: on });
            }}
          />
        ))}
        <Label>{PINGS.settings.where}</Label>
        {blocked ? (
          <View testID="settings-ping-this-iphone" style={rowStyle(color.hairline)}>
            <TwoLine title={PINGS.thisIphone} line={PINGS.settings.blocked} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={PINGS.openSettings}
              testID="settings-ping-open-settings"
              hitSlop={8}
              onPress={() => {
                select();
                Linking.openSettings().catch(() => {});
              }}
            >
              <Text
                style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 15, color: color.ink }}
              >
                {PINGS.openSettings}
              </Text>
            </Pressable>
          </View>
        ) : mine ? (
          <Row
            title={PINGS.thisIphone}
            line={PINGS.settings.pings}
            testID="settings-ping-this-iphone"
            on={mine.pings}
            onChange={(on) => {
              select();
              setDevicePings.mutate({ deviceId: mine.id, pings: on });
            }}
          />
        ) : permission === "undetermined" ? (
          <View testID="settings-ping-this-iphone" style={rowStyle(color.hairline)}>
            <TwoLine title={PINGS.thisIphone} line={PINGS.notAsked} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={PINGS.ask.turnOn}
              testID="settings-ping-turn-on"
              hitSlop={8}
              onPress={() => {
                select();
                void pings.turnOn().then(async () => {
                  setPermission(await native.permission().catch(() => null));
                  if (cloud.userId) setDeviceId(await devices.read(cloud.userId));
                  void answer.refetch();
                });
              }}
            >
              <Text
                style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 15, color: color.ink }}
              >
                {PINGS.ask.turnOn}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </SectionCard>
    </>
  );
}

const rowStyle = (hairline: string) =>
  ({
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: hairline,
  }) as const;

function Label({ children }: { children: string }) {
  const { color } = useTheme();
  return (
    <Text
      style={{
        paddingTop: 12,
        paddingBottom: 4,
        paddingHorizontal: 14,
        fontFamily: "Inter",
        fontWeight: "500",
        fontSize: 12,
        color: color.faint,
      }}
    >
      {children}
    </Text>
  );
}

function TwoLine({ title, line }: { title: string; line: string }) {
  const { color } = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 15, color: color.ink }}>
        {title}
      </Text>
      <Text style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 18, color: color.muted }}>
        {line}
      </Text>
    </View>
  );
}

function Row({
  title,
  line,
  on,
  onChange,
  testID,
}: {
  title: string;
  line: string;
  on: boolean;
  onChange: (on: boolean) => void;
  testID: string;
}) {
  const { color } = useTheme();
  return (
    <View testID={testID} style={rowStyle(color.hairline)}>
      <TwoLine title={title} line={line} />
      <Switch
        accessibilityLabel={title}
        testID={`${testID}-switch`}
        value={on}
        onValueChange={onChange}
      />
    </View>
  );
}
