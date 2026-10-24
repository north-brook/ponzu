import type { MenuAction } from "@react-native-menu/menu";
import { router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { barMenuItems } from "../../../components/bar-menu";
import { HeaderTitle } from "../../../components/chrome";
import { Glass } from "../../../components/glass";
import { AgentMark, Done, FileIcon, Inbox, PageIcon, Quiet } from "../../../components/icons";
import { MacImage } from "../../../components/preview";
import {
  type ActivityFilter,
  type ActivityItem,
  type ActivityKind,
  activityEmpty,
  changeTarget,
  filterActivity,
  filtersOn,
  shortAgent,
  title,
  where,
  whileInFront,
} from "../../../lib/activity";
import {
  activityFilter,
  markActivitySeen,
  markItemsSeen,
  pruneItemsSeen,
  setActivityFilter,
  useActivity,
} from "../../../lib/activity-store";
import { useFiles } from "../../../lib/catalog";
import { shortAgo } from "../../../lib/files";
import { select, tick } from "../../../lib/haptics";
import { baseUrl } from "../../../lib/mac";
import { findMac } from "../../../lib/macs";
import { useMargin } from "../../../lib/margin";
import { useStore } from "../../../lib/store";
import { track } from "../../../lib/telemetry";
import { useTheme } from "../../../lib/theme";
import { refreshThreads, useThreadDocs } from "../../../lib/threads";
import { brand } from "../../../lib/tokens";
import { useWindowInsets } from "../../../lib/window-insets";

/** The kinds in the filter's menu, with their images from the asset catalog. */
const KINDS: { id: ActivityKind; label: string; image: string; none: string }[] = [
  { id: "all", label: "All kinds", image: "hi-grid", none: "" },
  { id: "changes", label: "Changes", image: "hi-edit", none: "No changes yet" },
  { id: "replies", label: "Replies", image: "hi-comment", none: "No replies yet" },
  { id: "resolved", label: "Resolved", image: "hi-resolved", none: "Nothing resolved yet" },
];

/**
 * Activity (the iPhone design's Activity page), the Activity tab: what agents
 * changed in your designs, their replies to you in threads, and comments of
 * yours they resolved, as one list, newest first, with the yuzu dot on what's
 * unread. The glass filter top right, as Designs', shows New (the default)
 * or Everything, and every kind or one; off the default, it wears a count.
 * An agent at work right now leads, and always counts as new. See
 * lib/activity.ts for what each is built from and how the filter picks.
 */
export default function Activity() {
  const rail = useWindowInsets();
  const { color } = useTheme();
  const files = useFiles();
  const docs = useThreadDocs();
  const m = useMargin();
  // Development: `ponzu://activity?since=<ms>` shows what's new since then.
  const { since } = useLocalSearchParams<{ since?: string }>();
  const { fresh, old } = useActivity(__DEV__ && since ? Number(since) : undefined);
  // New is what was unseen when the tab came to the front, rebuilt each time it does (a tab
  // stays mounted, and a design opened from it comes back to it). While it's in front, a row
  // just seen keeps its place, its dot fading, and anything unseen that arrives joins it.
  const freshNow = useRef(fresh);
  freshNow.current = fresh;
  const [snapshot, setSnapshot] = useState<ReadonlySet<string>>(
    () => new Set(fresh.map((i) => i.id)),
  );
  // Anything unseen that arrives while the tab is in front joins the snapshot, so it too
  // keeps its row once seen.
  useEffect(() => {
    if (fresh.some((i) => !snapshot.has(i.id)))
      setSnapshot((now) => new Set([...now, ...fresh.map((i) => i.id)]));
  }, [fresh]);
  const shown = useMemo(() => whileInFront(snapshot, { fresh, old }), [snapshot, fresh, old]);
  const filter = useStore(activityFilter);
  const list = filterActivity(shown, filter);
  const empty = activityEmpty(shown, filter);
  // Dots: what's unseen right now.
  const unread = useMemo(() => new Set(fresh.map((i) => i.id)), [fresh]);

  // The tabs navigator itself (app/(tabs)/_layout.tsx), to tell which tab took the front.
  const tabs = useNavigation("/(tabs)");
  const [inFront, setInFront] = useState(false);
  useFocusEffect(
    useCallback(() => {
      track("activity opened");
      setSnapshot(new Set(freshNow.current.map((i) => i.id)));
      setInFront(true);
      // Fetch the threads of designs the person has commented in, from Macs that answer.
      for (const f of files) {
        const k = `${f.mac}:${f.key}`;
        const mac = findMac(f.mac);
        if (!mac || f.stale || !docs[k]) continue;
        refreshThreads(f, baseUrl(mac));
      }
      return () => {
        setInFront(false);
        const state = tabs.getState();
        // A design opened from Activity covers it: not a leaving, but it's rebuilt on return.
        if (state && state.routes[state.index]?.name === "(activity)") return;
        const all = [...freshNow.current];
        markActivitySeen(all);
        pruneItemsSeen(all);
      };
    }, []),
  );

  // Seeing a row: at least 60% of it on screen for 600ms while Activity is in front.
  const scrollY = useRef(0);
  const viewH = useRef(0);
  const rows = useRef(new Map<string, { y: number; h: number }>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const byId = useRef(new Map<string, ActivityItem>());
  byId.current = new Map(list.map((i) => [i.id, i]));
  const look = useCallback(() => {
    for (const [id, r] of rows.current) {
      const top = Math.max(r.y, scrollY.current);
      const bottom = Math.min(r.y + r.h, scrollY.current + viewH.current);
      const inView = inFront && r.h > 0 && (bottom - top) / r.h >= SEEN_SHARE;
      const waiting = timers.current.get(id);
      if (inView && !waiting && unread.has(id)) {
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id);
            const item = byId.current.get(id);
            if (item) markItemsSeen([item]);
          }, SEEN_MS),
        );
      } else if (!inView && waiting) {
        clearTimeout(waiting);
        timers.current.delete(id);
      }
    }
  }, [inFront, unread]);
  useEffect(() => {
    look();
  }, [look, list]);
  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t);
    },
    [],
  );
  const onRow = (id: string, y: number, h: number) => {
    rows.current.set(id, { y, h });
    look();
  };

  const open = (item: ActivityItem) => {
    tick();
    markItemsSeen([item]);
    const artboard = item.kind === "change" ? changeTarget(item) : undefined;
    router.push({
      pathname: "/design/[mac]/[key]",
      params: {
        mac: item.file.mac,
        key: item.file.key,
        ...(item.kind === "reply" ? { thread: item.thread.id } : {}),
        ...(artboard ? { artboard } : {}),
      },
    });
  };

  // The filter menu: New or Everything, then every kind or one, the current ones checked.
  const filters = useMemo<MenuAction[]>(
    () => [
      {
        id: "show",
        title: "Show",
        displayInline: true,
        subactions: [
          { id: "show:new", title: "New", image: "bar-new", state: on(filter.show === "new") },
          {
            id: "show:all",
            title: "Everything",
            image: "bar-everything",
            state: on(filter.show === "all"),
          },
        ],
      },
      {
        id: "kinds",
        title: "Kind",
        displayInline: true,
        subactions: KINDS.map((k) => ({
          id: `kind:${k.id}`,
          title: k.label,
          ...(k.image ? { image: k.image } : {}),
          state: on(filter.kind === k.id),
        })),
      },
    ],
    [filter],
  );
  const pick = (next: Partial<ActivityFilter>) => {
    select();
    setActivityFilter({ ...filter, ...next });
  };
  const pickFilter = (id: string) => {
    if (id.startsWith("show:")) pick({ show: id.slice(5) as ActivityFilter["show"] });
    else if (id.startsWith("kind:")) pick({ kind: id.slice(5) as ActivityKind });
  };
  const count = filtersOn(filter);

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <HeaderTitle color={color.ink}>Activity</HeaderTitle>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      {/* The filter, as Designs': the system's menu from a glass button, a count when one's on. */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu accessibilityLabel={count ? `Filter, ${count} on` : "Filter"}>
          <Stack.Toolbar.Icon renderingMode="template" xcasset="bar-filter" />
          {count > 0 && (
            <Stack.Toolbar.Badge style={{ backgroundColor: brand.yuzu, color: brand.ink }}>
              {String(count)}
            </Stack.Toolbar.Badge>
          )}
          {barMenuItems(filters, pickFilter)}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {/* The screen's first view, so the header's soft scroll edge finds it. */}
      <ScrollView
        testID="activity"
        style={{ flex: 1, backgroundColor: color.bg }}
        onLayout={(e) => {
          viewH.current = e.nativeEvent.layout.height;
          look();
        }}
        onScroll={(e) => {
          // The offset under the header's inset: the top of what's on screen, in content.
          scrollY.current = e.nativeEvent.contentOffset.y + e.nativeEvent.contentInset.top;
          look();
        }}
        scrollEventThrottle={100}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingTop: 8,
          // Clear of the system's rail at the side (iPhone Duo), as Designs' cards are.
          marginLeft: rail.left,
          marginRight: rail.right,
          paddingBottom: 24,
        }}
      >
        <View style={{ paddingTop: 4, paddingHorizontal: m }}>
          {list.length > 0 && (
            <Group items={list} unread={unread} onOpen={open} onRow={onRow} top={GROUP_TOP} />
          )}
        </View>
      </ScrollView>
      {empty && (
        <Empty
          kind={empty}
          none={KINDS.find((k) => k.id === filter.kind)?.none ?? ""}
          onEverything={() => pick({ show: "all" })}
          onAllKinds={() => pick({ kind: "all" })}
        />
      )}
    </>
  );
}

const on = (b: boolean) => (b ? ("on" as const) : ("off" as const));

/** A row counts as seen once this much of it has been on screen this long. */
const SEEN_SHARE = 0.6;
const SEEN_MS = 600;
/** The list's top padding above the group, in its content (the ScrollView's 8 and the View's 4). */
const GROUP_TOP = 12;

/** The unread dot: there while unread, fading out as it's seen. */
function Dot({ on: shown }: { on: boolean }) {
  const o = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    o.value = withTiming(shown ? 1 : 0, { duration: 250 });
  }, [shown]);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      testID={shown ? "activity-unread" : undefined}
      style={[
        {
          width: 8,
          height: 8,
          borderRadius: 999,
          backgroundColor: brand.yuzu,
          boxShadow: "0 0 0 1px rgba(17,17,16,0.18)",
        },
        style,
      ]}
    />
  );
}

/**
 * An empty list, centered in the screen, over it (so nothing moves): caught
 * up, with the way to everything; nothing ever, on a first run; or none of
 * the kind picked, with the way back to all kinds.
 */
function Empty({
  kind,
  none,
  onEverything,
  onAllKinds,
}: {
  kind: "caughtUp" | "never" | "noKind";
  none: string;
  onEverything: () => void;
  onAllKinds: () => void;
}) {
  const { color } = useTheme();
  const copy = {
    caughtUp: {
      title: "You're all caught up",
      body: "When an agent changes your designs or replies to you, it shows up here.",
    },
    never: {
      title: "Nothing yet",
      body: "Ask an agent on your Mac to work in a design. What it changes, and its replies to your comments, will show up here.",
    },
    noKind: { title: none, body: "" },
  }[kind];
  const action =
    kind === "caughtUp"
      ? { label: "Show everything", onPress: onEverything, id: "activity-show-everything" }
      : kind === "noKind"
        ? { label: "Show all kinds", onPress: onAllKinds, id: "activity-show-all-kinds" }
        : null;
  return (
    <View
      pointerEvents="box-none"
      testID={`activity-empty-${kind}`}
      style={{
        position: "absolute",
        inset: 0,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 40,
        gap: 10,
      }}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 999,
          backgroundColor: color.chip,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 6,
        }}
      >
        {kind === "never" ? <Quiet color={color.muted} /> : <Done color={color.muted} />}
      </View>
      <Text
        style={{
          fontFamily: "Funnel Display",
          fontWeight: "700",
          fontSize: 22,
          lineHeight: 26.4,
          letterSpacing: -0.03 * 22,
          color: color.ink,
          textAlign: "center",
        }}
      >
        {copy.title}
      </Text>
      {copy.body ? (
        <Text
          style={{
            maxWidth: 280,
            fontFamily: "Inter",
            fontSize: 15,
            lineHeight: 21.75,
            color: color.muted,
            textAlign: "center",
          }}
        >
          {copy.body}
        </Text>
      ) : null}
      {action && (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          testID={action.id}
          style={{ marginTop: 6 }}
        >
          {({ pressed }) => (
            <Glass
              interactive
              held={pressed}
              style={{
                height: 40,
                paddingHorizontal: 16,
                flexDirection: "row",
                alignItems: "center",
                gap: 7,
              }}
            >
              {kind === "caughtUp" && <Inbox color={color.ink} />}
              <Text
                style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 14, color: color.ink }}
              >
                {action.label}
              </Text>
            </Glass>
          )}
        </Pressable>
      )}
    </View>
  );
}

function Group({
  items,
  unread,
  onOpen,
  onRow,
  top,
}: {
  items: ActivityItem[];
  /** Ids of what's new: those rows wear the yuzu dot. */
  unread: Set<string>;
  onOpen: (item: ActivityItem) => void;
  /** Where each row is in the list's content, for what's on screen. */
  onRow: (id: string, y: number, h: number) => void;
  /** The group's top in the list's content. */
  top: number;
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
          fresh={unread.has(item.id)}
          last={i === items.length - 1}
          onPress={() => onOpen(item)}
          onLayout={(y, h) => onRow(item.id, top + y, h)}
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
  onLayout,
}: {
  item: ActivityItem;
  fresh: boolean;
  onLayout: (y: number, h: number) => void;
  last: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const client = item.kind === "work" ? item.agent?.client : item.client;
  const workTitle =
    item.kind === "work" && item.agent
      ? `${shortAgent(item.agent.name)} ${item.agent.activity === "working" ? "is working on" : "is iterating on"} ${item.file.name}`
      : item.kind === "work"
        ? `${item.file.name} changed`
        : null;
  return (
    <Pressable
      onPress={onPress}
      onLayout={(e) => onLayout(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      accessibilityRole="button"
      testID={`activity-${item.kind}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: color.hairline,
        opacity: pressed ? 0.7 : 1,
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
            {/* Unread: the dot. Once seen it fades (250ms) but keeps its place, so nothing moves. */}
            <Dot on={fresh} />
          </View>
          <Where item={item} />
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
        {item.kind === "change" && (
          <Strip
            mac={item.file.mac}
            live={!item.file.stale}
            boards={item.change.artboards.filter((a) => a.thumb).slice(0, 3)}
          />
        )}
        {item.kind === "work" && !item.agent && item.file.artboards.length > 0 && (
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

/**
 * The item's second line, as the cards and Search's rows read: the file's
 * icon and name, then each page with its own icon (or, for a reply, the
 * board), 13pt, the icons faint, "·" between. Work in a design now reads as
 * the agent's status.
 */
function Where({ item }: { item: ActivityItem }) {
  const { color } = useTheme();
  const line = where(item);
  const text = { fontFamily: "Inter", fontSize: 13, lineHeight: 16.9, color: color.muted };
  if (!line) {
    const status = item.kind === "work" ? item.agent?.status : undefined;
    return (
      <Text numberOfLines={1} style={text}>
        {status ?? `On ${item.file.macName}`}
      </Text>
    );
  }
  return (
    <View testID="activity-where" style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <FileIcon size={13} color={color.faint} width={1.5} />
      <Text numberOfLines={1} style={[text, { flexShrink: 0, maxWidth: "60%" }]}>
        {line.file}
      </Text>
      {line.places.map((p) => (
        <Fragment key={p.name}>
          <Text style={[text, { color: color.faint }]}>·</Text>
          <PageIcon name={p.icon} size={13} color={color.faint} width={1.5} />
          <Text numberOfLines={1} style={[text, { flexShrink: 1 }]}>
            {p.name}
          </Text>
        </Fragment>
      ))}
    </View>
  );
}

/** Up to three of a change's artboards, side by side (the design's 58pt strip). */
function Strip({
  mac,
  live,
  boards,
}: {
  mac: string;
  live: boolean;
  boards: { id: string; thumb?: string }[];
}) {
  const { color } = useTheme();
  if (!boards.length) return null;
  return (
    <View testID="activity-thumbs" style={{ flexDirection: "row", gap: 6 }}>
      {boards.map((a) => (
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
            mac={mac}
            url={a.thumb ?? null}
            live={live}
            style={{ width: "100%", height: "100%" }}
          />
        </View>
      ))}
    </View>
  );
}
