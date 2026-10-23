import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { Easing, FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Lockup } from "../components/chrome";
import { FileCard } from "../components/file-card";
import { Glass } from "../components/glass";
import { Bell, Branch, Check, Chevron, Folder, Moon, Search } from "../components/icons";
import { useActivityCount } from "../lib/activity-store";
import { refreshFeeds, syncFeeds, useCatalogs, useFiles, useShelve } from "../lib/catalog";
import { clock, type PhoneFile, projects, type Shelf, shelfOf } from "../lib/files";
import type { ShelfAction } from "../lib/mac-queries";
import { SLICE, SLICE_STROKE } from "../lib/mark";
import { reachAll, useMacs } from "../lib/reach";
import { isUnseen, useSeen } from "../lib/seen";
import { useTheme } from "../lib/theme";
import { brand, EASE_OUT } from "../lib/tokens";

const SHELVES: { id: Shelf; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "scratch", label: "Scratch" },
  { id: "archived", label: "Archived" },
];

/**
 * Designs (Flow › 1 Designs): the desktop dashboard for a phone. The lockup
 * and the Activity bell, search, one filter row (the shelf menu, then a chip
 * per project), and every Mac's designs as cards, newest first. Macs that
 * didn't answer keep their cards from last time, dimmed, under a note.
 */
export default function Designs() {
  const { color, shadow } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const files = useFiles();
  const seen = useSeen();
  const { macs, reach } = useMacs();
  const all = useCatalogs();
  const [shelf, setShelf] = useState<Shelf>("recent");
  const [project, setProject] = useState<string | null | undefined>(undefined);
  const [menu, setMenu] = useState(false);
  const [pulled, setPulled] = useState(false);
  const count = useActivityCount();
  const shelve = useShelve();
  useEffect(syncFeeds, []);
  // The menu is a modal over the whole app: it goes when Designs does.
  useFocusEffect(useCallback(() => () => setMenu(false), []));

  const onShelf = useMemo(() => files.filter((f) => shelfOf(f) === shelf), [files, shelf]);
  const counts = useMemo(() => {
    const c: Record<Shelf, number> = { recent: 0, scratch: 0, archived: 0 };
    for (const f of files) c[shelfOf(f)]++;
    return c;
  }, [files]);
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

  const cardWidth = (width - 40 - 16) / 2;
  const open = (f: PhoneFile) =>
    router.push({ pathname: "/design/[mac]/[key]", params: { mac: f.mac, key: f.key } });
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
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: f.name,
        options: [...choices.map((c) => c.label), "Cancel"],
        cancelButtonIndex: choices.length,
      },
      (i) => {
        const choice = choices[i];
        if (!choice) return;
        shelve.mutate(
          { mac: f.mac, key: f.key, action: choice.action },
          {
            onError: () =>
              Alert.alert(
                `Couldn't move “${f.name}”`,
                f.stale
                  ? `${f.macName} isn't answering. Try again once it's back.`
                  : `${f.macName} didn't take the change.`,
              ),
          },
        );
      },
    );
  };

  return (
    <View testID="designs" style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top, paddingBottom: insets.bottom + 24 }}
        refreshControl={
          <RefreshControl
            refreshing={pulled}
            onRefresh={() => {
              setPulled(true);
              refreshFeeds();
              reachAll().finally(() => setPulled(false));
            }}
            tintColor={color.faint}
          />
        }
      >
        <Rise i={0}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingTop: 10,
              paddingBottom: 12,
              paddingHorizontal: 20,
            }}
          >
            <Lockup color={color.ink} />
            <Pressable
              onPress={() => router.push("/activity")}
              accessibilityRole="button"
              accessibilityLabel={count ? `Activity, ${count} new` : "Activity"}
              testID="bell"
            >
              <Glass
                interactive
                style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
              >
                <Bell color={color.ink} />
              </Glass>
              {count > 0 && (
                <View
                  style={{
                    position: "absolute",
                    top: -3,
                    right: -3,
                    minWidth: 18,
                    height: 18,
                    paddingHorizontal: 5,
                    borderRadius: 999,
                    backgroundColor: brand.yuzu,
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: `0 0 0 2px ${color.bg}`,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: "Inter",
                      fontWeight: "700",
                      fontSize: 11,
                      color: brand.ink,
                    }}
                  >
                    {count > 99 ? "99+" : count}
                  </Text>
                </View>
              )}
            </Pressable>
          </View>
        </Rise>
        <Rise i={1}>
          <Pressable
            onPress={() => router.push("/search")}
            accessibilityRole="search"
            testID="search-field"
            style={{
              marginHorizontal: 20,
              height: 44,
              borderRadius: 12,
              backgroundColor: color.card,
              boxShadow: shadow.board,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 14,
            }}
          >
            <Search color={color.faint} />
            <Text style={{ fontFamily: "Inter", fontSize: 16, color: color.faint }}>
              Search designs
            </Text>
          </Pressable>
        </Rise>
        <Rise i={2}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingTop: 16,
              paddingBottom: 18,
              paddingHorizontal: 20,
              gap: 6,
              alignItems: "center",
            }}
          >
            <Pressable
              onPress={() => setMenu(true)}
              accessibilityRole="button"
              accessibilityLabel={`Shelf: ${SHELVES.find((s) => s.id === shelf)!.label}`}
              testID="shelf"
              style={{
                height: 32,
                paddingLeft: 12,
                paddingRight: 10,
                borderRadius: 999,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: color.card,
                boxShadow: shadow.board,
              }}
            >
              <Text
                style={{ fontFamily: "Inter", fontWeight: "600", fontSize: 13, color: color.ink }}
              >
                {SHELVES.find((s) => s.id === shelf)!.label}
              </Text>
              <Text
                style={{
                  fontFamily: "Inter",
                  fontWeight: "500",
                  fontSize: 13,
                  color: color.ink,
                  opacity: 0.5,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {counts[shelf]}
              </Text>
              <Chevron color={color.muted} />
            </Pressable>
            <View
              style={{ width: 1, height: 18, backgroundColor: color.hairline, marginHorizontal: 4 }}
            />
            <Chip
              label="All"
              count={onShelf.length}
              on={project === undefined}
              onPress={() => setProject(undefined)}
            />
            {chips.map((p) => (
              <Chip
                key={p.name ?? "none"}
                label={p.name ?? "Not in a project"}
                icon={p.name ? "branch" : "folder"}
                count={p.count}
                on={project === p.name}
                onPress={() => setProject(project === p.name ? undefined : p.name)}
              />
            ))}
          </ScrollView>
        </Rise>
        {arriving.length > 0 && files.length > 0 && (
          <Notice>
            <Juice color={color.faint} />
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
            paddingHorizontal: 20,
            flexDirection: "row",
            flexWrap: "wrap",
            columnGap: 16,
            rowGap: 22,
          }}
        >
          {shown.map((f, i) => (
            <Rise key={f.id} i={3 + Math.min(i, 6) * 0.5}>
              <FileCard
                file={f}
                width={cardWidth}
                unseen={isUnseen(seen, f.mac, f.key, f.modified)}
                onPress={() => open(f)}
                onLongPress={() => actions(f)}
              />
            </Rise>
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
      <ShelfMenu
        open={menu}
        top={insets.top + 226 - 54 + 6}
        shelf={shelf}
        counts={counts}
        onPick={(s) => {
          setShelf(s);
          setProject(undefined);
          setMenu(false);
        }}
        onClose={() => setMenu(false)}
      />
    </View>
  );
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The page rises in a stagger as it arrives from the launch screen. */
function Rise({ i, children }: { i: number; children: React.ReactNode }) {
  return (
    <Animated.View
      entering={FadeInDown.delay(80 + i * 60)
        .duration(500)
        .withInitialValues({ transform: [{ translateY: 16 }] })
        .easing(Easing.bezier(...EASE_OUT))}
    >
      {children}
    </Animated.View>
  );
}

function Notice({ children, gap = 10 }: { children: React.ReactNode; gap?: number }) {
  const { color, shadow } = useTheme();
  return (
    <View
      style={{
        marginHorizontal: 20,
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

/** The slice's segments fading in turn: "still looking". */
function Juice({ color }: { color: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % 6), 200);
    return () => clearInterval(t);
  }, []);
  return (
    <Svg width={16} height={16} viewBox="0 0 64 64">
      {SLICE.map((d, k) => (
        <Path
          key={d}
          d={d}
          fill={color}
          stroke={color}
          strokeWidth={SLICE_STROKE}
          strokeLinejoin="round"
          opacity={(k - i + 6) % 6 < 3 ? 0.16 + ((k - i + 6) % 6) * 0.28 : 1}
        />
      ))}
    </Svg>
  );
}

function Chip({
  label,
  count,
  on,
  icon,
  onPress,
}: {
  label: string;
  count: number;
  on: boolean;
  icon?: "branch" | "folder";
  onPress: () => void;
}) {
  const { color, scheme } = useTheme();
  const fg = on ? color.bg : color.muted;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={{
        height: 32,
        paddingHorizontal: 12,
        borderRadius: 999,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: on ? color.ink : "transparent",
        boxShadow: on
          ? undefined
          : `inset 0 0 0 1px ${scheme === "dark" ? "rgba(255,255,255,0.2)" : "rgba(17,17,16,0.12)"}`,
      }}
    >
      {icon === "branch" && <Branch size={14} color={fg} width={1.6} />}
      {icon === "folder" && <Folder size={14} color={fg} width={1.6} />}
      <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 13, color: fg }}>
        {label}
      </Text>
      <Text
        style={{
          fontFamily: "Inter",
          fontWeight: "500",
          fontSize: 13,
          color: fg,
          opacity: 0.6,
          fontVariant: ["tabular-nums"],
        }}
      >
        {count}
      </Text>
    </Pressable>
  );
}

/** Recent ▾ (Flow › 1 Designs · shelf menu): the three shelves with their counts. */
function ShelfMenu({
  open,
  top,
  shelf,
  counts,
  onPick,
  onClose,
}: {
  open: boolean;
  top: number;
  shelf: Shelf;
  counts: Record<Shelf, number>;
  onPick: (s: Shelf) => void;
  onClose: () => void;
}) {
  const { color, shadow, scheme } = useTheme();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{
          flex: 1,
          backgroundColor: scheme === "dark" ? "rgba(0,0,0,0.35)" : "rgba(17,17,16,0.12)",
        }}
        onPress={onClose}
        accessibilityLabel="Close"
      />
      <View
        testID="shelf-menu"
        style={{
          position: "absolute",
          left: 20,
          top,
          width: 220,
          paddingVertical: 6,
          borderRadius: 14,
          backgroundColor: color.card,
          boxShadow: `${shadow.pop}, 0 0 0 1px ${color.hairline}`,
        }}
      >
        {SHELVES.map((s, i) => (
          <View key={s.id}>
            <Pressable
              onPress={() => onPick(s.id)}
              accessibilityRole="menuitem"
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                height: 44,
                paddingHorizontal: 14,
                backgroundColor: pressed ? color.canvas : "transparent",
              })}
            >
              <View style={{ width: 16 }}>{s.id === shelf && <Check color={color.ink} />}</View>
              <Text
                style={{
                  flex: 1,
                  fontFamily: "Inter",
                  fontWeight: "500",
                  fontSize: 16,
                  color: color.ink,
                }}
              >
                {s.label}
              </Text>
              <Text
                style={{
                  fontFamily: "Inter",
                  fontWeight: "500",
                  fontSize: 16,
                  color: color.faint,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {counts[s.id]}
              </Text>
            </Pressable>
            {i === 0 && (
              <View
                style={{
                  height: 1,
                  marginVertical: 2,
                  marginHorizontal: 14,
                  backgroundColor: color.hairline,
                }}
              />
            )}
          </View>
        ))}
      </View>
    </Modal>
  );
}
