import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";
import { holding } from "../../components/handoff";
import { select } from "../../lib/haptics";
import { useStore } from "../../lib/store";
import { useTheme } from "../../lib/theme";

/**
 * Each tab's mark, as Hugeicons (scripts/tab-icons.ts): the outline, and
 * the same outline heavier while the tab is in front, the free set having
 * no solid icons. Drawn as templates, so the bar tints them in light and
 * dark alike.
 */
const MARKS = {
  designs: {
    default: require("../../assets/native/tab-designs.png"),
    selected: require("../../assets/native/tab-designs-fill.png"),
  },
  search: {
    default: require("../../assets/native/tab-search.png"),
    selected: require("../../assets/native/tab-search-fill.png"),
  },
};

/**
 * An iPad's tab bar is a row of names across the top, with no room for marks
 * alone: there each tab says its name, which VoiceOver reads too (it doesn't
 * read the trigger's label there). An iPhone's shows the marks only.
 */
const NAMES = Platform.OS === "ios" && Platform.isPad;

/** A tab changing is felt, as a selection: each press, the current tab's again too. */
const TAB_LISTENERS = { tabPress: select };

/**
 * The app once connected, in the system's tab bar: Designs and Search, by
 * their marks alone, together in one bar. Search is a plain tab, not the
 * system's search tab, which iOS 26 sets apart from the bar and would leave
 * Designs alone in it; its field is in its header (search.tsx). Each tab is a
 * stack of its own. The canvas isn't a tab: it's pushed over both on the
 * root stack, so the bar goes with the tabs as it comes in, and no tab bar
 * shows over it. Designs pads itself under the status bar and above the
 * tab bar, so the system's automatic content insets are off for it;
 * Search's native header insets its list.
 */
export default function TabsLayout() {
  const { color } = useTheme();
  // Arriving from the launch screen, the bar comes in with the page (components/handoff.tsx).
  const held = useStore(holding);
  return (
    <NativeTabs
      minimizeBehavior="never"
      screenListeners={TAB_LISTENERS}
      tintColor={color.ink}
      hidden={held}
    >
      <NativeTabs.Trigger
        name="(designs)"
        accessibilityLabel="Designs"
        testID="tab-designs"
        disableAutomaticContentInsets
      >
        <NativeTabs.Trigger.Icon renderingMode="template" src={MARKS.designs} />
        <NativeTabs.Trigger.Label hidden={!NAMES}>Designs</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(search)" accessibilityLabel="Search" testID="tab-search">
        <NativeTabs.Trigger.Icon renderingMode="template" src={MARKS.search} />
        <NativeTabs.Trigger.Label hidden={!NAMES}>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
