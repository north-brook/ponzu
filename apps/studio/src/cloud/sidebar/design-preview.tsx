import type { DesignPreview } from "../model.ts";
import { cn } from "../ui/cn.ts";
import { useColorScheme } from "../ui/color-scheme.ts";

/** A design's first page in miniature, in the app's scheme; an empty tile until it has one. */
export function DesignPreviewImage({
  preview,
  width,
  height,
  className,
}: {
  preview: DesignPreview | null;
  width: number;
  height: number;
  className?: string;
}) {
  const scheme = useColorScheme();
  return (
    <span
      // A design's own pixels: blocked in a private recording (app/analytics/privacy.ts).
      data-replay="block"
      className={cn("block shrink-0 overflow-hidden rounded-4 bg-hover shadow-preview", className)}
      style={{ width, height }}
    >
      {preview ? (
        <img
          // A new picture gets a fresh element: one that failed to load doesn't hide the next.
          key={preview[scheme]}
          src={preview[scheme]}
          alt=""
          draggable={false}
          // Not drawn yet, or gone: the empty tile, never a broken picture.
          onError={(e) => {
            e.currentTarget.hidden = true;
          }}
          className="block size-full object-cover object-top"
        />
      ) : null}
    </span>
  );
}
