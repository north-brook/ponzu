import { useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { ScrollView } from "react-native";
import { SearchResults } from "../../../components/search-results";
import { SEARCH } from "../../../lib/copy";
import { useMargin } from "../../../lib/margin";
import { useTheme } from "../../../lib/theme";
import { brand } from "../../../lib/tokens";

/**
 * Search, the second tab (search design §10): the system's search field in the header, and under
 * it the canvases changed most recently, then, as words are typed, the workspace's Canvases,
 * Boards and Threads from the API's search (components/search-results.tsx, lib/search.ts). The
 * list keeps clear of the keyboard, so the last result can be scrolled to with it up.
 */
export default function Search() {
  const { color } = useTheme();
  const m = useMargin();
  const [query, setQuery] = useState("");
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: SEARCH.placeholder,
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
  return (
    <ScrollView
      testID="search"
      style={{ flex: 1, backgroundColor: color.bg }}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 24 }}
    >
      <SearchResults query={query} margin={m} />
    </ScrollView>
  );
}
