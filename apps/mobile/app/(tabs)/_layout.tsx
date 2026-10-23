import { NativeTabs } from "expo-router/native-tabs";
import { holding } from "../../components/handoff";
import { useActivityCount } from "../../lib/activity-store";
import { select } from "../../lib/haptics";
import { useStore } from "../../lib/store";
import { useTheme } from "../../lib/theme";
import { brand } from "../../lib/tokens";

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
  activity: {
    default: require("../../assets/native/tab-activity.png"),
    selected: require("../../assets/native/tab-activity-fill.png"),
  },
};

/** A tab changing is felt, as a selection: each press, the current tab's again too. */
const TAB_LISTENERS = { tabPress: select };

/**
 * The app once connected, in the system's tab bar: Designs, Search and
 * Activity, by their marks alone. Search is the system's search tab, set
 * apart from the others on iOS 26, its field the system's (search.tsx).
 * Activity carries the count of what's new as its badge. Each tab is a
 * stack of its own. The canvas isn't a tab: it's pushed over all of them
 * on the root stack, so the bar goes with the tabs as it comes in, and no
 * tab bar shows over it. Designs and Activity pad themselves under the
 * status bar and above the tab bar, so the system's automatic content
 * insets are off for them; Search's native header insets its list.
 */
export default function TabsLayout() {
  const { color } = useTheme();
  const count = useActivityCount();
  // Arriving from the launch screen, the bar comes in with the page (components/handoff.tsx).
  const held = useStore(holding);
  return (
    <NativeTabs
      minimizeBehavior="never"
      screenListeners={TAB_LISTENERS}
      tintColor={color.ink}
      // The brand's yuzu, not the system's red. iOS draws the count in white
      // on it; only Android takes a text color.
      badgeBackgroundColor={brand.yuzu}
      hidden={held}
    >
      <NativeTabs.Trigger
        name="(designs)"
        accessibilityLabel="Designs"
        testID="tab-designs"
        disableAutomaticContentInsets
      >
        <NativeTabs.Trigger.Icon renderingMode="template" src={MARKS.designs} />
        <NativeTabs.Trigger.Label hidden />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="(activity)"
        accessibilityLabel={count ? `Activity, ${count} new` : "Activity"}
        testID="tab-activity"
        disableAutomaticContentInsets
      >
        <NativeTabs.Trigger.Icon renderingMode="template" src={MARKS.activity} />
        <NativeTabs.Trigger.Label hidden />
        {/* No badge at all with nothing new: a hidden one still draws "0". */}
        {count > 0 && (
          <NativeTabs.Trigger.Badge>{count > 99 ? "99+" : String(count)}</NativeTabs.Trigger.Badge>
        )}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="(search)"
        accessibilityLabel="Search"
        testID="tab-search"
        // The system's search tab: on iOS 26 a glass button apart from the
        // others, which opens its field when selected.
        role="search"
        unstable_nativeProps={{ ios: { role: "search", automaticallyActivatesSearch: true } }}
      >
        <NativeTabs.Trigger.Icon renderingMode="template" src={MARKS.search} />
        <NativeTabs.Trigger.Label hidden />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
