import {
  type Artboard,
  type Doc,
  findArtboard,
  isThemed,
  type Thread,
  threadPage,
} from "@ponzu/core";

/** Helpers the film and its edit share. */

/** Light or dark for a board's own light-dark() colours: the canvas's theme when it's themed, as the canvas does. */
export function schemeFor(doc: Doc, ab: Artboard, theme: "light" | "dark"): "light" | "dark" {
  return isThemed(doc.tokens, ab.root) ? theme : "light";
}

/** Fonts and images in a shadow root, with a time limit. */
export async function settleAssets(root: ShadowRoot | Document, ms = 4000): Promise<void> {
  const imgs = [...root.querySelectorAll("img")].filter((i) => !i.complete);
  const all = Promise.all([
    document.fonts.ready,
    ...imgs.map(
      (img) =>
        new Promise<void>((r) => {
          img.addEventListener("load", () => r(), { once: true });
          img.addEventListener("error", () => r(), { once: true });
        }),
    ),
  ]);
  await Promise.race([all, new Promise((r) => setTimeout(r, ms))]);
}

/** Where a pin sits on the canvas. */
export function pinSpot(doc: Doc, t: Thread): { page: string; x: number; y: number } | null {
  const page = threadPage(doc, t);
  if (!page) return null;
  const ab = t.artboardId ? findArtboard(doc, t.artboardId)?.artboard : undefined;
  return { page: page.id, x: (ab?.x ?? 0) + t.x, y: (ab?.y ?? 0) + t.y };
}
