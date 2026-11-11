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
      className={cn("block shrink-0 overflow-hidden rounded-4 bg-hover shadow-preview", className)}
      style={{ width, height }}
    >
      {preview ? (
        <img
          src={preview[scheme]}
          alt=""
          draggable={false}
          className="block size-full object-cover object-top"
        />
      ) : null}
    </span>
  );
}
