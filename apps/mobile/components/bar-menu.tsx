import type { MenuAction } from "@react-native-menu/menu";
import { Stack } from "expo-router";
import type { ReactElement } from "react";

/**
 * A menu item's image: one of the Hugeicons in the asset catalog (`hi-*`,
 * `bar-*`, scripts/tab-icons.ts). The app has one icon language, so no
 * system symbols.
 */
function itemIcon(image: string | undefined): ReactElement | null {
  if (!image) {
    return null;
  }
  return <Stack.Toolbar.Icon renderingMode="template" xcasset={image} />;
}

/**
 * A list of menu actions, the shape the app's menus share
 * (`@react-native-menu/menu`'s), as the header's own menu items, as
 * augmenter's components/bar-menu.tsx: a submenu stays a submenu, an inline
 * group a group set apart, a checked one checked. Picking one calls
 * `onPick` with its id.
 *
 * A function, not a component: the header's menu reads its items from its
 * direct children, so they must be the toolbar's own elements.
 */
export function barMenuItems(
  actions: readonly MenuAction[],
  onPick: (id: string) => void,
): ReactElement[] {
  return actions.map((action) => {
    const id = action.id ?? action.title;
    if (action.subactions?.length) {
      return (
        <Stack.Toolbar.Menu
          destructive={action.attributes?.destructive}
          inline={action.displayInline}
          key={id}
          title={action.displayInline ? undefined : action.title}
        >
          {itemIcon(action.image)}
          {barMenuItems(action.subactions, onPick)}
        </Stack.Toolbar.Menu>
      );
    }
    return (
      <Stack.Toolbar.MenuAction
        destructive={action.attributes?.destructive}
        disabled={action.attributes?.disabled}
        isOn={action.state === "on"}
        key={id}
        onPress={() => onPick(id)}
        subtitle={action.subtitle}
      >
        {itemIcon(action.image)}
        <Stack.Toolbar.Label>{action.title}</Stack.Toolbar.Label>
      </Stack.Toolbar.MenuAction>
    );
  });
}
