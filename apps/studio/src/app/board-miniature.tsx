import { ArtboardView } from "@ponzu/canvas";
import type { Artboard, Doc } from "@ponzu/core";
import { boardSize, frameFit } from "./thread-map.ts";

/**
 * A board of the open design in a comment's frame in the thread: drawn as the canvas draws it,
 * scaled to cover the frame and centered, as `pinOf` places the pin. It shows the board as it was
 * when the comment was made (`frozen`, the copy the API kept with the comment), with the
 * design's tokens as they are now; without a copy (a board too large to keep, or a comment from
 * before copies were kept), the board as it is now. A board that is gone, with no copy, leaves
 * the frame's own ground.
 */
export function BoardMiniature({
  doc,
  artboardId,
  frozen = null,
  assetBase,
  theme,
}: {
  doc: Doc | null;
  artboardId: string;
  frozen?: Artboard | null;
  assetBase: string | undefined;
  theme: "light" | "dark";
}) {
  const board =
    frozen ?? doc?.pages.flatMap((page) => page.artboards).find((ab) => ab.id === artboardId);
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
