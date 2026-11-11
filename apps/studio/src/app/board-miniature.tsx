import { ArtboardView } from "@ponzu/canvas";
import type { Doc } from "@ponzu/core";
import { boardSize, frameFit } from "./thread-map.ts";

/**
 * A board of the open design in a comment's frame in the thread: drawn as the canvas draws it,
 * scaled to cover the frame and centered, as `pinOf` places the pin. A board that is gone leaves
 * the frame's own ground.
 */
export function BoardMiniature({
  doc,
  artboardId,
  assetBase,
  theme,
}: {
  doc: Doc | null;
  artboardId: string;
  assetBase: string | undefined;
  theme: "light" | "dark";
}) {
  const board = doc?.pages.flatMap((page) => page.artboards).find((ab) => ab.id === artboardId);
  if (!doc || !board) return null;
  const size = boardSize(board);
  const fit = frameFit(size);
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: fit.left,
        top: fit.top,
        width: size.width,
        height: size.height,
        transform: `scale(${fit.scale})`,
        transformOrigin: "0 0",
      }}
    >
      <ArtboardView
        artboard={board}
        tokens={doc.tokens}
        {...(assetBase ? { assetBase } : {})}
        colorScheme={theme}
        hold
      />
    </div>
  );
}
