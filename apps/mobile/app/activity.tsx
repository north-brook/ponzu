import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BarButton } from "../components/chrome";
import { AgentMark, Back } from "../components/icons";
import { MacImage } from "../components/preview";
import { type ActivityItem, shortAgent, title } from "../lib/activity";
import { markActivitySeen, useActivity } from "../lib/activity-store";
import { useFiles } from "../lib/catalog";
import { shortAgo } from "../lib/files";
import { baseUrl } from "../lib/mac";
import { findMac } from "../lib/macs";
import { track } from "../lib/telemetry";
import { useTheme } from "../lib/theme";
import { refreshThreads, useThreadDocs } from "../lib/threads";
import { brand } from "../lib/tokens";

/**
 * Activity (Flow › 10, from the bell): replies to you in threads, agents'
 * work in your designs, and comments of yours they resolved; New since you
 * last looked, then Seen. See lib/activity.ts for what each is built from.
 */
export default function Activity() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const files = useFiles();
  const docs = useThreadDocs();
  // Development: `ponzu://activity?since=<ms>` shows what's new since then.
  const { since } = useLocalSearchParams<{ since?: string }>();
  const { fresh, old } = useActivity(__DEV__ && since ? Number(since) : undefined);
  // What was new when the screen opened stays under New while it's open.
  const opened = useRef<{ fresh: ActivityItem[]; old: ActivityItem[] } | null>(null);
  opened.current ??= fresh.length || old.length ? { fresh, old } : null;
  const shown = opened.current && fresh.length === 0 ? opened.current : { fresh, old };

  useEffect(() => {
    track("activity opened");
    // Fetch the threads of designs the person has commented in, from Macs that answer.
    for (const f of files) {
      const k = `${f.mac}:${f.key}`;
      const mac = findMac(f.mac);
      if (!mac || f.stale || !docs[k]) continue;
      refreshThreads(f, baseUrl(mac));
    }
    return () => markActivitySeen();
  }, []);

  const open = (item: ActivityItem) =>
    router.push({
      pathname: "/design/[mac]/[key]",
      params: {
        mac: item.file.mac,
        key: item.file.key,
        ...(item.kind === "reply" ? { thread: item.thread.id } : {}),
      },
    });

  return (
    <View testID="activity" style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + 24 }}
      >
        <View
          style={{ paddingTop: 6, paddingBottom: 4, paddingHorizontal: 16, flexDirection: "row" }}
        >
          <BarButton label="Back" onPress={() => router.back()}>
            <Back color={color.ink} />
          </BarButton>
        </View>
        <Text
          style={{
            paddingTop: 8,
            paddingBottom: 12,
            paddingHorizontal: 20,
            fontFamily: "Funnel Display",
            fontWeight: "700",
            fontSize: 34,
            lineHeight: 37.4,
            letterSpacing: -0.03 * 34,
            color: color.ink,
          }}
        >
          Activity
        </Text>
        <View style={{ paddingTop: 4, paddingHorizontal: 20, gap: 12 }}>
          {shown.fresh.length > 0 && (
            <>
              <Label text="New" />
              <Group items={shown.fresh} fresh onOpen={open} />
            </>
          )}
          {shown.old.length > 0 && (
            <>
              <Label text="Seen" top={shown.fresh.length ? 6 : 0} />
              <Group items={shown.old} onOpen={open} />
            </>
          )}
          {!shown.fresh.length && !shown.old.length && (
            <Text
              style={{
                marginTop: 24,
                textAlign: "center",
                fontFamily: "Inter",
                fontSize: 15,
                lineHeight: 22,
                color: color.muted,
              }}
            >
              Nothing yet. When an agent replies to you or works in your designs, it shows here.
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function Label({ text, top = 0 }: { text: string; top?: number }) {
  const { color } = useTheme();
  return (
    <Text
      style={{
        paddingTop: top,
        paddingHorizontal: 4,
        fontFamily: "Inter",
        fontWeight: "600",
        fontSize: 13,
        color: color.muted,
      }}
    >
      {text}
    </Text>
  );
}

function Group({
  items,
  fresh = false,
  onOpen,
}: {
  items: ActivityItem[];
  fresh?: boolean;
  onOpen: (item: ActivityItem) => void;
}) {
  const { color, shadow } = useTheme();
  return (
    <View
      style={{
        borderRadius: 16,
        backgroundColor: color.card,
        boxShadow: shadow.board,
        overflow: "hidden",
      }}
    >
      {items.map((item, i) => (
        <Item
          key={item.id}
          item={item}
          fresh={fresh}
          last={i === items.length - 1}
          onPress={() => onOpen(item)}
        />
      ))}
    </View>
  );
}

function Item({
  item,
  fresh,
  last,
  onPress,
}: {
  item: ActivityItem;
  fresh: boolean;
  last: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const client = item.kind === "work" ? item.agent?.client : item.client;
  const where =
    item.kind === "reply"
      ? [item.file.name, item.boardName].filter(Boolean).join(" · ")
      : item.kind === "resolved"
        ? [item.file.name, item.boards.map((b) => b.name).join(", ")].filter(Boolean).join(" · ")
        : (item.agent?.status ?? `On ${item.file.macName}`);
  const workTitle =
    item.kind === "work" && item.agent
      ? `${shortAgent(item.agent.name)} ${item.agent.activity === "working" ? "is working on" : "is iterating on"} ${item.file.name}`
      : item.kind === "work"
        ? `${item.file.name} changed`
        : null;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: color.hairline,
        opacity: pressed ? 0.7 : fresh ? 1 : 0.7,
      })}
    >
      <View style={{ width: 24, height: 22, alignItems: "center", justifyContent: "center" }}>
        <AgentMark client={client} size={16} color={color.ink} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              style={{
                flex: 1,
                fontFamily: "Inter",
                fontWeight: "600",
                fontSize: 15,
                lineHeight: 19.5,
                color: color.ink,
              }}
            >
              {workTitle ?? title(item)}
            </Text>
            <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.faint }}>
              {shortAgo(item.at)}
            </Text>
            {fresh && (
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  backgroundColor: brand.yuzu,
                  boxShadow: "0 0 0 1px rgba(17,17,16,0.18)",
                }}
              />
            )}
          </View>
          <Text
            numberOfLines={1}
            style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 16.9, color: color.muted }}
          >
            {where}
          </Text>
        </View>
        {item.kind === "reply" && (
          <Text
            numberOfLines={3}
            style={{ fontFamily: "Inter", fontSize: 15, lineHeight: 21.75, color: color.ink }}
          >
            {item.text}
          </Text>
        )}
        {item.kind === "resolved" && item.boards.length > 0 && (
          <View style={{ flexDirection: "row", gap: 6 }}>
            {item.boards.slice(0, 4).map((b) => {
              const a = item.file.artboards.find((x) => x.id === b.id);
              return (
                <View
                  key={b.id}
                  style={{
                    width: 46,
                    height: 100,
                    borderRadius: 6,
                    overflow: "hidden",
                    boxShadow: `0 0 0 1px ${color.hairline}`,
                  }}
                >
                  <MacImage
                    mac={item.file.mac}
                    url={a?.thumb ?? null}
                    live={!item.file.stale}
                    style={{ width: "100%", height: "100%" }}
                  />
                </View>
              );
            })}
          </View>
        )}
        {item.kind === "work" && item.file.artboards.length > 0 && (
          <View style={{ flexDirection: "row", gap: 6 }}>
            {item.file.artboards.slice(0, 3).map((a) => (
              <View
                key={a.id}
                style={{
                  flex: 1,
                  height: 58,
                  borderRadius: 6,
                  overflow: "hidden",
                  backgroundColor: color.canvas,
                  boxShadow: `0 0 0 1px ${color.hairline}`,
                }}
              >
                <MacImage
                  mac={item.file.mac}
                  url={a.thumb}
                  live={!item.file.stale}
                  style={{ width: "100%", height: "100%" }}
                />
              </View>
            ))}
          </View>
        )}
      </View>
    </Pressable>
  );
}
