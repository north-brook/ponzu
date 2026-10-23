import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { FileCard, Marked, useMarkColor } from "../../../components/file-card";
import { MacImage } from "../../../components/preview";
import { useFiles } from "../../../lib/catalog";
import { search } from "../../../lib/search";
import { isUnseen, useSeen } from "../../../lib/seen";
import { useTheme } from "../../../lib/theme";
import { brand } from "../../../lib/tokens";

/**
 * Search (Flow › 2 Search), the search tab: the system's search field, and
 * results as Files (cards) and Frames (artboards, with the page and design
 * they're in), matches marked. `?q=` starts it with a query.
 */
export default function Search() {
  const { color } = useTheme();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ q?: string }>();
  const [query, setQuery] = useState(params.q ?? "");
  const files = useFiles();
  const seen = useSeen();
  const markColor = useMarkColor();
  const results = useMemo(() => search(files, query), [files, query]);
  const cardWidth = (width - 40 - 16) / 2;
  const label = {
    fontFamily: "Inter",
    fontWeight: "600" as const,
    fontSize: 13,
    color: color.muted,
    paddingHorizontal: 22,
  };
  // The system's search field, in the native header: glass on iOS 26, and the
  // search tab's own (role="search" in the tabs layout).
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search designs",
        autoCapitalize: "none",
        autoFocus: true,
        hideWhenScrolling: false,
        tintColor: brand.yuzu,
        textColor: color.ink,
        onChangeText: (e: { nativeEvent: { text: string } }) => setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
      },
    });
  }, [navigation, color.ink]);
  return (
    <View testID="search" style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ gap: 14, paddingTop: 8, paddingBottom: 24 }}
      >
        {results.files.length > 0 && (
          <>
            <Text style={label} testID="search-files">
              Files
            </Text>
            <View
              style={{
                paddingHorizontal: 20,
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
                  onPress={() =>
                    router.push({
                      pathname: "/design/[mac]/[key]",
                      params: { mac: h.file.mac, key: h.file.key },
                    })
                  }
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
                paddingHorizontal: 20,
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
                    router.push({
                      pathname: "/design/[mac]/[key]",
                      params: { mac: h.file.mac, key: h.file.key, artboard: h.artboard.id },
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
        {query.trim() && !results.files.length && !results.frames.length && (
          <Text
            style={{
              marginTop: 24,
              textAlign: "center",
              fontFamily: "Inter",
              fontSize: 15,
              color: color.muted,
            }}
          >
            Nothing matches “{query.trim()}”.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}
