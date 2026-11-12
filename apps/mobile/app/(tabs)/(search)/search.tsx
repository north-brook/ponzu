import { useNavigation } from "expo-router";
import { useLayoutEffect, useMemo, useState } from "react";
import { ScrollView, Text } from "react-native";
import { CanvasNameRow } from "../../../components/canvas-name-row";
import { useCanvases } from "../../../lib/cloud/canvases";
import { useMargin } from "../../../lib/margin";
import { useTheme } from "../../../lib/theme";
import { brand } from "../../../lib/tokens";

/** The canvases whose name or repo holds every word typed, in the list's order. */
export function matchNames<T extends { name: string; repoFullName: string | null }>(
  canvases: readonly T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...canvases];
  return canvases.filter((canvas) => {
    const text = `${canvas.name} ${canvas.repoFullName ?? "scratch"}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * Search, the second tab: the system's search field over the workspace's canvases, matched by
 * name on the phone. The search design's sections (Canvases, Boards, Threads, through the
 * workspace search route) arrive with the search slice.
 */
export default function Search() {
  const { color } = useTheme();
  const m = useMargin();
  const { canvases } = useCanvases();
  const [query, setQuery] = useState("");
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search canvases",
        autoCapitalize: "none",
        hideWhenScrolling: false,
        hideNavigationBar: false,
        obscureBackground: false,
        tintColor: brand.yuzu,
        textColor: color.ink,
        onChangeText: (e: { nativeEvent: { text: string } }) => setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
      },
    });
  }, [navigation, color.ink]);
  const found = useMemo(() => matchNames(canvases ?? [], query), [canvases, query]);
  return (
    <ScrollView
      testID="search"
      style={{ flex: 1, backgroundColor: color.bg }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingBottom: 24 }}
    >
      {found.map((canvas) => (
        <CanvasNameRow key={canvas.id} canvas={canvas} margin={m} />
      ))}
      {canvases && query.trim() && found.length === 0 && (
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
          Nothing called “{query.trim()}”.
        </Text>
      )}
    </ScrollView>
  );
}
