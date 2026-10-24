import { Icons } from "../../../packages/react/src/icon-names.ts";

/**
 * A page's icon, by the names design.json uses: desktop's Icons, one map for
 * every place the phone draws it. The header and Search draw the Hugeicon
 * itself (PageIcon); the native page menu names its image in the asset
 * catalog, `hi-<name>`, which scripts/tab-icons.ts renders from this same
 * map. A name the app doesn't know is the board, everywhere.
 */
export type PageIconName = keyof typeof Icons;

export const FALLBACK: PageIconName = "board";

/** The name a page's icon is drawn by. */
export function pageIconName(name: string | undefined): PageIconName {
  return name && Object.hasOwn(Icons, name) ? (name as PageIconName) : FALLBACK;
}

/** Its Hugeicon. */
export function pageIcon(name: string | undefined): (typeof Icons)[PageIconName] {
  return Icons[pageIconName(name)];
}

/** Its image in the asset catalog, for a native menu. */
export function pageIconImage(name: string | undefined): string {
  return `hi-${pageIconName(name)}`;
}
