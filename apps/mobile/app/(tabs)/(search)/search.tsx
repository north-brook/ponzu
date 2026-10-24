import { router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { HeaderTitle } from "../../../components/chrome";
import { FileCard, Marked, useMarkColor } from "../../../components/file-card";
import { Clock, MacIcon, PageIcon, Search as SearchGlyph } from "../../../components/icons";
import { MacImage } from "../../../components/preview";
import { useFiles } from "../../../lib/catalog";
import type { PhoneFile } from "../../../lib/files";
import { select, tick } from "../../../lib/haptics";
import { lately, noteSearch, type Opened } from "../../../lib/lately";
import { useMargin } from "../../../lib/margin";
import { useMacs } from "../../../lib/reach";
import { search } from "../../../lib/search";
import { isUnseen, useSeen } from "../../../lib/seen";
import { useStore } from "../../../lib/store";
import { useTheme } from "../../../lib/theme";
import { brand } from "../../../lib/tokens";
import { useWindowInsets } from "../../../lib/window-insets";

/**
 * Search (Flow › 2 Search), the search tab: the system's search field, and
 * results as Files (cards) and Frames (artboards, with the page and design
 * they're in), matches marked. Before anything's typed, the last few
 * searches and the designs opened lately; with nothing found, what was
 * searched. `?q=` starts it with a query.
 */
export default function Search() {
  const rail = useWindowInsets();
  const { color } = useTheme();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(params.q ?? "");
  const files = useFiles();
  const { macs } = useMacs();
  const { searches, opened } = useStore(lately);
  const bar = useRef<SearchBarCommands>(null);
  const seen = useSeen();
  const markColor = useMarkColor();
  const results = useMemo(() => search(files, query), [files, query]);
  const m = useMargin();
  // The page's width less the system's rail at the side (iPhone Duo), as Designs does.
  const cardWidth = (width - rail.left - rail.right - 2 * m - 16) / 2;
  const label = {
    fontFamily: "Inter",
    fontWeight: "600" as const,
    fontSize: 13,
    color: color.muted,
    paddingHorizontal: m,
  };
  // The system's search field, in the native header: glass on iOS 26, and the
  // search tab's own (role="search" in the tabs layout).
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        ref: bar,
        placeholder: "Search designs",
        autoCapitalize: "none",
        autoFocus: true,
        hideWhenScrolling: false,
        // The title stays in its row while the field is open, as on Designs.
        hideNavigationBar: false,
        obscureBackground: false,
        tintColor: brand.yuzu,
        textColor: color.ink,
        onChangeText: (e: { nativeEvent: { text: string } }) => setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        // A search the person settled on: kept for next time.
        onSearchButtonPress: (e: { nativeEvent: { text: string } }) =>
          noteSearch(e.nativeEvent.text),
      },
    });
  }, [navigation, color.ink]);
  const q = query.trim();
  const found = results.files.length > 0 || results.frames.length > 0;
  // Leaving with results on screen counts as settling on the search.
  const latest = useRef({ q, found });
  latest.current = { q, found };
  useFocusEffect(
    useCallback(
      () => () => {
        if (latest.current.found) noteSearch(latest.current.q);
      },
      [],
    ),
  );
  const again = (s: string) => {
    select();
    bar.current?.setText(s);
    setQuery(s);
  };
  const go = (pathname: "/design/[mac]/[key]", p: Record<string, string>) => {
    tick();
    if (found) noteSearch(q);
    router.push({ pathname, params: p as { mac: string; key: string } });
  };
  const lately3 = opened
    .map((o) => ({ o, file: files.find((f) => f.mac === o.mac && f.key === o.key) }))
    .filter((x): x is { o: (typeof opened)[number]; file: PhoneFile } => Boolean(x.file));
  const answering = macs.map((m) => m.name);

  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.View hidesSharedBackground>
          <HeaderTitle color={color.ink}>Search</HeaderTitle>
        </Stack.Toolbar.View>
      </Stack.Toolbar>
      {/* The screen's first view, so the header's soft scroll edge finds it. */}
      <ScrollView
        testID="search"
        style={{ flex: 1, backgroundColor: color.bg }}
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 14,
          paddingTop: 8,
          // Clear of the system's rail at the side (iPhone Duo), as Designs' cards are.
          marginLeft: rail.left,
          marginRight: rail.right,
          paddingBottom: 24,
        }}
      >
        {results.files.length > 0 && (
          <>
            <Text style={label} testID="search-files">
              Files
            </Text>
            <View
              style={{
                paddingHorizontal: m,
                flexDirection: "row",
                flexWrap: "wrap",
                columnGap: 16,
                rowGap: 16,
              }}
            >
              {results.files.map((h) => (
                <FileCard
                  key={h.file.id}
                  file={h.file}
                  width={cardWidth}
                  name={h.name}
                  unseen={isUnseen(seen, h.file.mac, h.file.key, h.file.modified)}
                  onPress={() => go("/design/[mac]/[key]", { mac: h.file.mac, key: h.file.key })}
                />
              ))}
            </View>
          </>
        )}
        {results.frames.length > 0 && (
          <>
            {results.files.length > 0 && <View style={{ height: 8 }} />}
            <Text style={label} testID="search-frames">
              Frames
            </Text>
            <View
              style={{
                paddingHorizontal: m,
                flexDirection: "row",
                flexWrap: "wrap",
                columnGap: 16,
                rowGap: 20,
              }}
            >
              {results.frames.map((h) => (
                <Pressable
                  key={`${h.file.id}:${h.artboard.id}`}
                  style={({ pressed }) => ({
                    width: cardWidth,
                    gap: 10,
                    opacity: pressed ? 0.7 : h.file.stale ? 0.45 : 1,
                  })}
                  onPress={() =>
                    go("/design/[mac]/[key]", {
                      mac: h.file.mac,
                      key: h.file.key,
                      artboard: h.artboard.id,
                    })
                  }
                >
                  <View
                    style={{
                      height: 118,
                      borderRadius: 12,
                      backgroundColor: color.canvas,
                      boxShadow: `0 0 0 1px ${color.hairline}`,
                      padding: 14,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <MacImage
                      mac={h.file.mac}
                      url={h.artboard.thumb}
                      live={!h.file.stale}
                      contentFit="contain"
                      contentPosition="center"
                      style={{ width: "100%", height: 90 }}
                    />
                  </View>
                  <View style={{ gap: 3, paddingHorizontal: 2 }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        fontFamily: "Inter",
                        fontWeight: "500",
                        fontSize: 15,
                        lineHeight: 19.5,
                        color: color.ink,
                      }}
                    >
                      <Marked runs={h.name} color={markColor} />
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        fontFamily: "Inter",
                        fontSize: 13,
                        lineHeight: 16.9,
                        color: color.muted,
                      }}
                    >
                      <Marked runs={h.where} color={markColor} />
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}
        {!q && (
          <Before
            searches={searches}
            opened={lately3}
            onSearch={again}
            onOpen={(x) =>
              go("/design/[mac]/[key]", {
                mac: x.file.mac,
                key: x.file.key,
                ...(x.o.page ? { page: x.o.page } : {}),
              })
            }
          />
        )}
        {q && !found && <NoMatches query={q} count={files.length} macs={answering} />}
      </ScrollView>
    </>
  );
}

const sectionLabel = {
  fontFamily: "Inter",
  fontWeight: "600" as const,
  fontSize: 13,
};

/** Before anything's typed: recent searches as chips, then the designs opened lately. */
function Before({
  searches,
  opened,
  onSearch,
  onOpen,
}: {
  searches: string[];
  opened: { o: Opened; file: PhoneFile }[];
  onSearch: (s: string) => void;
  onOpen: (x: { o: Opened; file: PhoneFile }) => void;
}) {
  const { color, scheme } = useTheme();
  const m = useMargin();
  const edge = scheme === "dark" ? "rgba(255,255,255,0.2)" : "rgba(17,17,16,0.12)";
  return (
    <View testID="search-before" style={{ gap: 14 }}>
      {searches.length > 0 && (
        <>
          <Text style={[sectionLabel, { color: color.muted, paddingHorizontal: m }]}>
            Recent searches
          </Text>
          <View style={{ paddingHorizontal: m, flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {searches.map((s) => (
              <Pressable
                key={s}
                onPress={() => onSearch(s)}
                accessibilityRole="button"
                accessibilityLabel={`Search for ${s}`}
                style={({ pressed }) => ({
                  height: 34,
                  paddingHorizontal: 12,
                  borderRadius: 999,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  opacity: pressed ? 0.6 : 1,
                  boxShadow: `inset 0 0 0 1px ${edge}`,
                })}
              >
                <Clock size={14} color={color.faint} />
                <Text
                  style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 14, color: color.ink }}
                >
                  {s}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      {opened.length > 0 && (
        <>
          <Text
            style={[
              sectionLabel,
              { color: color.muted, paddingHorizontal: m, paddingTop: searches.length ? 10 : 0 },
            ]}
          >
            Opened lately
          </Text>
          <View style={{ paddingHorizontal: m, gap: 10 }}>
            {opened.map((x) => {
              const page = x.file.pages.find((p) => p.id === x.o.page) ?? x.file.pages[0];
              const thumb = x.file.artboards?.find((a) => a.page === page?.id)?.thumb;
              return (
                <Pressable
                  key={`${x.o.mac}:${x.o.key}`}
                  onPress={() => onOpen(x)}
                  accessibilityRole="button"
                  testID={`opened-${x.file.name}`}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    opacity: pressed ? 0.6 : x.file.stale ? 0.45 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 64,
                      height: 48,
                      borderRadius: 8,
                      backgroundColor: color.canvas,
                      boxShadow: `0 0 0 1px ${color.hairline}`,
                      overflow: "hidden",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <MacImage
                      mac={x.file.mac}
                      url={thumb ?? x.file.preview}
                      live={!x.file.stale}
                      contentFit="contain"
                      contentPosition="center"
                      style={{ width: 56, height: 40 }}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        fontFamily: "Inter",
                        fontWeight: "500",
                        fontSize: 15,
                        color: color.ink,
                      }}
                    >
                      {x.file.name}
                    </Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      {page && (
                        <>
                          <PageIcon name={page.icon} size={13} color={color.faint} />
                          <Text
                            numberOfLines={1}
                            style={{
                              flexShrink: 1,
                              fontFamily: "Inter",
                              fontSize: 13,
                              color: color.muted,
                            }}
                          >
                            {page.name}
                          </Text>
                          <Text style={{ fontFamily: "Inter", fontSize: 13, color: color.faint }}>
                            ·
                          </Text>
                        </>
                      )}
                      <MacIcon kind={x.file.macKind} size={13} color={color.faint} />
                      <Text
                        numberOfLines={1}
                        style={{
                          flexShrink: 1,
                          fontFamily: "Inter",
                          fontSize: 13,
                          color: color.muted,
                        }}
                      >
                        {x.file.macName}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}

/** Nothing found: what was looked through, and how. */
function NoMatches({ query, count, macs }: { query: string; count: number; macs: string[] }) {
  const { color } = useTheme();
  const where =
    macs.length <= 1
      ? (macs[0] ?? "your Mac")
      : `${macs.slice(0, -1).join(", ")} and ${macs.at(-1)}`;
  return (
    <View
      testID="search-none"
      style={{ alignItems: "center", gap: 10, paddingTop: 48, paddingHorizontal: 40 }}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 999,
          backgroundColor: color.chip,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 6,
        }}
      >
        <SearchGlyph size={24} color={color.muted} />
      </View>
      <Text
        style={{
          textAlign: "center",
          fontFamily: "Inter",
          fontWeight: "600",
          fontSize: 17,
          color: color.ink,
        }}
      >
        No matches for “{query}”
      </Text>
      <Text
        style={{
          textAlign: "center",
          fontFamily: "Inter",
          fontSize: 14,
          lineHeight: 20,
          color: color.muted,
        }}
      >
        Searched {count} {count === 1 ? "design" : "designs"} on {where}, by name, page and frame.
      </Text>
    </View>
  );
}
