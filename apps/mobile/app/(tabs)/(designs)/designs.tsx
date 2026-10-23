import type { MenuAction } from "@react-native-menu/menu";
import { router, Stack } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  type HostInstance,
  RefreshControl,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { barMenuItems } from "../../../components/bar-menu";
import { Lockup } from "../../../components/chrome";
import { FileCard } from "../../../components/file-card";
import { HandoffRise, holding } from "../../../components/handoff";
import { Moon } from "../../../components/icons";
import { refreshFeeds, syncFeeds, useCatalogs, useFiles, useShelve } from "../../../lib/catalog";
import { clock, type PhoneFile, projects, type Shelf, shelfOf } from "../../../lib/files";
import { fail, select, thud, tick } from "../../../lib/haptics";
import type { ShelfAction } from "../../../lib/mac-queries";
import { LOCKUP_INK, measureMargin, useMargin } from "../../../lib/margin";
import { reachAll, useMacs } from "../../../lib/reach";
import { isUnseen, useSeen } from "../../../lib/seen";
import { Juice } from "../../../lib/slice";
import { useStore } from "../../../lib/store";
import { useTheme } from "../../../lib/theme";
import { brand } from "../../../lib/tokens";

const SHELVES: { id: Shelf; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "scratch", label: "Scratch" },
  { id: "archived", label: "Archived" },
];

/**
 * Designs (Flow › 1 Designs), the first tab: the desktop dashboard for a
 * phone. The lockup and a filter in the system's glass header, the grid
 * scrolling under it; every Mac's designs as cards, newest first. The
 * filter is the system's menu: the shelf (Recent, Scratch, Archived) and
 * the project, the current one checked; the button
 * wears a yuzu badge with how many filters are on. Search and Activity are tabs of
 * their own beside it. Macs that didn't answer keep their cards from last
 * time, dimmed, under a note.
 */
export default function Designs() {
  const { color } = useTheme();
  const { width } = useWindowDimensions();
  const files = useFiles();
  const seen = useSeen();
  const { macs, reach } = useMacs();
  const all = useCatalogs();
  const [shelf, setShelf] = useState<Shelf>("recent");
  const [project, setProject] = useState<string | null | undefined>(undefined);
  const [pulled, setPulled] = useState(false);
  const shelve = useShelve();
  // Arriving from the launch screen, the filter comes in with the page (components/handoff.tsx).
  const held = useStore(holding);
  useEffect(syncFeeds, []);

  const onShelf = useMemo(() => files.filter((f) => shelfOf(f) === shelf), [files, shelf]);
  const chips = useMemo(() => projects(onShelf), [onShelf]);
  const shown =
    project === undefined
      ? onShelf
      : onShelf.filter((f) => (f.git?.projectName ?? null) === project);

  // Macs still being asked, and Macs asleep with designs from last time.
  const arriving = macs.filter((m) => reach[m.id] === "asking" || reach[m.id] === "waking");
  const asleep = macs.filter(
    (m) => (reach[m.id] === "asleep" || reach[m.id] === "noTailnet") && all[m.id],
  );

  const m = useMargin();
  const header = useRef<HostInstance>(null);
  const cardWidth = (width - 2 * m - 16) / 2;
  const open = (f: PhoneFile) => {
    tick();
    router.push({ pathname: "/design/[mac]/[key]", params: { mac: f.mac, key: f.key } });
  };
  // Hold a card for its shelf, as desktop's card menu: the card moves at once.
  const actions = (f: PhoneFile) => {
    const on = shelfOf(f);
    const choices: { label: string; action: ShelfAction }[] =
      on === "archived"
        ? [{ label: "Restore", action: "restore" }]
        : [
            on === "scratch"
              ? { label: "Move to Recent", action: "recent" }
              : { label: "Move to Scratch", action: "scratch" },
            { label: "Archive", action: "archive" },
          ];
    // The sheet is the app's, not the system's context menu: it has no haptic of its own.
    select();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: f.name,
        options: [...choices.map((c) => c.label), "Cancel"],
        cancelButtonIndex: choices.length,
      },
      (i) => {
        const choice = choices[i];
        if (!choice) return;
        if (choice.action === "archive") thud();
        else select();
        shelve.mutate(
          { mac: f.mac, key: f.key, action: choice.action },
          {
            onError: () => {
              fail();
              Alert.alert(
                `Couldn't move “${f.name}”`,
                f.stale
                  ? `${f.macName} isn't answering. Try again once it's back.`
                  : `${f.macName} didn't take the change.`,
              );
            },
          },
        );
      },
    );
  };

  // The filter menu: the shelf, then the project, each the current one checked.
  const shelfLabel = SHELVES.find((s) => s.id === shelf)!.label;
  const projectLabel = project === undefined ? null : (project ?? "Not in a project");
  const filters = useMemo<MenuAction[]>(
    () => [
      {
        id: "shelves",
        title: "Shelf",
        displayInline: true,
        subactions: SHELVES.map((s) => ({
          id: `shelf:${s.id}`,
          title: s.label,
          image: s.id === "recent" ? "hi-home" : s.id === "scratch" ? "hi-scratch" : "hi-archive",
          state: s.id === shelf ? "on" : "off",
        })),
      },
      {
        id: "projects",
        title: "Project",
        displayInline: true,
        subactions: [
          {
            id: "project:*",
            title: "All",
            image: "hi-grid",
            state: project === undefined ? "on" : "off",
          },
          ...chips.map((c) => ({
            id: `project:${c.name ?? ""}`,
            title: c.name ?? "Not in a project",
            image: c.name ? "hi-branch" : "hi-folder",
            state: project === c.name ? ("on" as const) : ("off" as const),
          })),
        ],
      },
    ],
    [shelf, project, chips],
  );
  const pickFilter = (id: string) => {
    select();
    if (id.startsWith("shelf:")) {
      setShelf(id.slice(6) as Shelf);
      setProject(undefined);
    } else if (id === "project:*") setProject(undefined);
    else if (id.startsWith("project:")) setProject(id.slice(8) || null);
  };
  /** Filters on: a shelf other than Recent, a project other than All. The button's badge counts them. */
  const on = (shelf !== "recent" ? 1 : 0) + (project !== undefined ? 1 : 0);

  return (
    <>
      {/* The lockup and the filter in the system's header, over the grid as it scrolls. */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          {/* Where the header puts it is the margin (lib/margin.ts); the slice's ink sits on it. */}
          <View
            ref={header}
            onLayout={() => header.current?.measureInWindow((x) => measureMargin(x))}
          >
            <View style={{ marginLeft: -LOCKUP_INK }}>
              <Lockup color={color.ink} />
            </View>
          </View>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          hidden={held}
          accessibilityLabel={
            on ? `Filter: ${[shelfLabel, projectLabel].filter(Boolean).join(", ")}` : "Filter"
          }
        >
          <Stack.Toolbar.Icon renderingMode="template" xcasset="bar-filter" />
          {on > 0 && (
            <Stack.Toolbar.Badge style={{ backgroundColor: brand.yuzu, color: brand.ink }}>
              {String(on)}
            </Stack.Toolbar.Badge>
          )}
          {barMenuItems(filters, pickFilter)}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      {/* The screen's first view, so the header's soft scroll edge finds it (react-native-screens
          looks down the first-subview chain). */}
      <ScrollView
        testID="designs"
        style={{ flex: 1, backgroundColor: color.bg }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 24 }}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            onRefresh={() => {
              // The pull crossed its threshold.
              tick();
              setPulled(true);
              refreshFeeds();
              reachAll().finally(() => setPulled(false));
            }}
            tintColor={color.faint}
          />
        }
      >
        {arriving.length > 0 && files.length > 0 && (
          <Notice>
            <Juice size={16} color={color.faint} />
            <Text
              style={{
                flex: 1,
                fontFamily: "Inter",
                fontWeight: "500",
                fontSize: 14,
                lineHeight: 18.2,
                color: color.muted,
              }}
            >
              Finding {listNames(arriving.map((m) => m.name))} on your tailnet…
            </Text>
          </Notice>
        )}
        {asleep.map((m) => (
          <Notice key={m.id} gap={12}>
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
              <Moon size={17} color={color.muted} width={1.9} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontFamily: "Inter",
                  fontWeight: "600",
                  fontSize: 15,
                  lineHeight: 19.5,
                  color: color.ink,
                }}
              >
                {m.name} is asleep
              </Text>
              <Text
                style={{ fontFamily: "Inter", fontSize: 13, lineHeight: 17.55, color: color.muted }}
              >
                Its designs are as they were at {clock(all[m.id]!.at)}.
              </Text>
            </View>
          </Notice>
        ))}
        <View
          style={{
            paddingHorizontal: m,
            flexDirection: "row",
            flexWrap: "wrap",
            columnGap: 16,
            rowGap: 22,
          }}
        >
          {shown.map((f, i) => (
            <HandoffRise key={f.id} kind="designs" i={i}>
              <FileCard
                file={f}
                width={cardWidth}
                unseen={isUnseen(seen, f.mac, f.key, f.modified)}
                onPress={() => open(f)}
                onLongPress={() => actions(f)}
              />
            </HandoffRise>
          ))}
        </View>
        {shown.length === 0 && (
          <Text
            style={{
              marginTop: 40,
              marginHorizontal: 40,
              textAlign: "center",
              fontFamily: "Inter",
              fontSize: 15,
              lineHeight: 22,
              color: color.muted,
            }}
          >
            {files.length === 0
              ? arriving.length
                ? "Finding your designs…"
                : "No designs yet. Ask an agent on your Mac to make one."
              : shelf === "recent"
                ? "Nothing here."
                : `Nothing in ${SHELVES.find((s) => s.id === shelf)!.label}.`}
          </Text>
        )}
      </ScrollView>
    </>
  );
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function Notice({ children, gap = 10 }: { children: React.ReactNode; gap?: number }) {
  const { color, shadow } = useTheme();
  const m = useMargin();
  return (
    <View
      style={{
        marginHorizontal: m,
        marginBottom: 16,
        paddingVertical: gap === 12 ? 12 : 10,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: color.card,
        boxShadow: shadow.board,
        flexDirection: "row",
        alignItems: "center",
        gap,
      }}
    >
      {children}
    </View>
  );
}
