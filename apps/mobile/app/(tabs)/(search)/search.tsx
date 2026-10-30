import { router, Stack, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { HeaderTitle } from "../../../components/chrome";
import { FileCard, Marked, useMarkColor } from "../../../components/file-card";
import { Search as SearchGlyph } from "../../../components/icons";
import { MacImage } from "../../../components/preview";
import { shortAgent } from "../../../lib/agents";
import { useFiles } from "../../../lib/catalog";
import { designColumns } from "../../../lib/duo-layout";
import { type PhoneFile, shelfOf, shortAgo, whereLine } from "../../../lib/files";
import { tick } from "../../../lib/haptics";
import { useMargin } from "../../../lib/margin";
import { useMacs } from "../../../lib/reach";
import { search } from "../../../lib/search";
import { isUnseen, useSeen } from "../../../lib/seen";
import { useTheme } from "../../../lib/theme";
import { brand } from "../../../lib/tokens";
import { useWindowInsets } from "../../../lib/window-insets";

/**
 * Search (Flow › 2 Search), the search tab: the system's search field, and
 * results as Files (cards) and Frames (artboards, with the page and design
 * they're in), matches marked. Before anything's typed, the designs
 * changed lately; with nothing found, what was searched. `?q=` starts it with a query.
 */
export default function Search() {
  const rail = useWindowInsets();
  const { color } = useTheme();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(params.q ?? "");
  const files = useFiles();
  const { macs } = useMacs();
  const bar = useRef<SearchBarCommands>(null);
  const seen = useSeen();
  const markColor = useMarkColor();
  const results = useMemo(() => search(files, query), [files, query]);
  const m = useMargin();
  // The page's width less the system's rail at the side (iPhone Duo), in Designs' columns.
  const page = width - rail.left - rail.right;
  const columns = designColumns(page);
  const cardWidth = (page - 2 * m - 16 * (columns - 1)) / columns;
  const label = {
    fontFamily: "Inter",
    fontWeight: "600" as const,
    fontSize: 13,
    color: color.muted,
    paddingHorizontal: m,
  };
  // The system's search field, in the native header: glass on iOS 26.
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
      },
    });
  }, [navigation, color.ink]);
  const q = query.trim();
  const found = results.files.length > 0 || results.frames.length > 0;
  useFocusEffect(
    useCallback(() => {
      // The field is in the header, and a plain tab doesn't open it: it's opened here, so
      // choosing Search is ready to type.
      const open = Platform.OS === "ios" ? setTimeout(() => bar.current?.focus(), 300) : undefined;
      return () => clearTimeout(open);
    }, []),
  );
  const go = (pathname: "/design/[mac]/[key]", p: Record<string, string>) => {
    tick();
    router.push({ pathname, params: p as { mac: string; key: string } });
  };
  const changed = useMemo(
    () => files.filter((f) => shelfOf(f) === "recent" && !f.locked).slice(0, SUGGEST),
    [files],
  );
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
            files={changed}
            onOpen={(f) => go("/design/[mac]/[key]", { mac: f.mac, key: f.key })}
          />
        )}
        {q && !found && <NoMatches query={q} count={files.length} macs={answering} />}
      </ScrollView>
    </>
  );
}

/** How many of the designs changed lately Search suggests. */
const SUGGEST = 6;

/**
 * Before anything's typed: the designs changed lately on any Mac, newest
 * first, each with who's in it now, when it changed and its branch.
 */
function Before({ files, onOpen }: { files: PhoneFile[]; onOpen: (f: PhoneFile) => void }) {
  const { color } = useTheme();
  const m = useMargin();
  return (
    <View testID="search-before" style={{ paddingHorizontal: m, gap: 10 }}>
      {files.map((f) => {
        const agent = f.agents?.find((a) => a.activity === "working") ?? f.agents?.[0];
        const where = whereLine(f);
        const thumb = f.artboards?.[0]?.thumb;
        return (
          <Pressable
            key={f.id}
            onPress={() => onOpen(f)}
            accessibilityRole="button"
            testID={`changed-${f.name}`}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              opacity: pressed ? 0.6 : f.stale ? 0.45 : 1,
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
                mac={f.mac}
                url={thumb ?? f.preview}
                live={!f.stale}
                contentFit="contain"
                contentPosition="center"
                style={{ width: 56, height: 40 }}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <Text
                numberOfLines={1}
                style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 15, color: color.ink }}
              >
                {f.name}
              </Text>
              <Text
                numberOfLines={1}
                style={{ fontFamily: "Inter", fontSize: 13, color: color.muted }}
              >
                {[
                  agent && shortAgent(agent.name),
                  shortAgo(f.modified),
                  where.branch ?? where.folder,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Nothing found: what was looked through, and how. */
function NoMatches({ query, count, macs }: { query: string; count: number; macs: string[] }) {
  const { color } = useTheme();
  const where =
    macs.length <= 1
      ? (macs[0] ?? "your computer")
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
