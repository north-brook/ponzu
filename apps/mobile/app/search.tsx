import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FileCard, Marked, useMarkColor } from "../components/file-card";
import { Close, Search as SearchIcon } from "../components/icons";
import { MacImage } from "../components/preview";
import { useFiles } from "../lib/catalog";
import { search } from "../lib/search";
import { isUnseen, useSeen } from "../lib/seen";
import { useTheme } from "../lib/theme";
import { brand } from "../lib/tokens";

/**
 * Search (Flow › 2 Search): one field with the yuzu focus ring, and results
 * as Files (cards) and Frames (artboards, with the page and design they're
 * in), matches marked.
 */
export default function Search() {
  const { color, scheme } = useTheme();
  const insets = useSafeAreaInsets();
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
  return (
    <View testID="search" style={{ flex: 1, backgroundColor: color.bg, paddingTop: insets.top }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingTop: 10,
          paddingBottom: 18,
          paddingHorizontal: 20,
        }}
      >
        <View
          style={{
            flex: 1,
            height: 44,
            borderRadius: 12,
            backgroundColor: color.card,
            boxShadow: `0 0 0 1px ${brand.yuzu}, 0 0 0 4px ${scheme === "dark" ? "rgba(255,200,30,0.22)" : "rgba(255,200,30,0.22)"}`,
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingLeft: 14,
            paddingRight: 10,
          }}
        >
          <SearchIcon color={color.faint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="Search designs"
            placeholderTextColor={color.faint}
            selectionColor={brand.yuzu}
            cursorColor={brand.yuzu}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            testID="search-input"
            style={{
              flex: 1,
              fontFamily: "Inter",
              fontSize: 16,
              color: color.ink,
              height: 44,
              padding: 0,
            }}
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => setQuery("")}
              accessibilityLabel="Clear"
              hitSlop={8}
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                backgroundColor: color.chip,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Close size={12} color={color.muted} width={2.4} />
            </Pressable>
          )}
        </View>
        <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={8}>
          <Text style={{ fontFamily: "Inter", fontWeight: "500", fontSize: 16, color: color.ink }}>
            Cancel
          </Text>
        </Pressable>
      </View>
      <ScrollView
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ gap: 14, paddingBottom: insets.bottom + 24 }}
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
