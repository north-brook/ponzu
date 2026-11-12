import { getImageProps } from "next/image";

/*
 * A product shot: the Mac window as the studio's gallery draws it (`bun scripts/visual.ts shots`
 * in apps/studio, into public/product/<id>-<theme>.png), in the visitor's scheme through
 * <picture>. Next's image optimizer serves it as WebP or AVIF at the width the page needs.
 *
 * Every shot is drawn at 1440×900 at twice the scale. `crop` shows part of one, as fractions of
 * its width and height; the box keeps that part's shape before the picture loads, so nothing on
 * the page moves when it arrives.
 */

/** The site's product shots, as apps/studio/scripts/visual-lib.ts SITE_SHOTS names them. */
export type ShotId =
  | "thread-in-the-right-rail"
  | "pull-request-tab"
  | "together-on-a-canvas"
  | "team-sidebar"
  | "create";

const WIDTH = 2880;
const HEIGHT = 1800;

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

const WHOLE: Crop = { x: 0, y: 0, w: 1, h: 1 };

export function HeroShot({
  id,
  alt,
  crop = WHOLE,
  sizes,
  priority = false,
  className = "",
}: {
  id: ShotId;
  alt: string;
  crop?: Crop;
  /** How wide the box is drawn, for the optimizer (the `sizes` attribute). */
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  // The picture is wider than the box by 1/w, so the box's width asks for that much more.
  const scaled = crop.w === 1 ? sizes : scaleSizes(sizes, 1 / crop.w);
  const common = {
    alt,
    width: WIDTH,
    height: HEIGHT,
    sizes: scaled,
    // Not `preload`: it would fetch the light picture even for a dark page.
    ...(priority ? { loading: "eager" as const, fetchPriority: "high" as const } : {}),
  };
  const dark = getImageProps({ ...common, src: `/product/${id}-dark.png` }).props;
  const { props: light } = getImageProps({ ...common, src: `/product/${id}-light.png` });
  const ratio = (crop.w * WIDTH) / (crop.h * HEIGHT);
  return (
    <div
      className={`shot relative overflow-hidden ${className}`}
      style={{ aspectRatio: `${ratio}` }}
    >
      <picture>
        <source media="(prefers-color-scheme: dark)" srcSet={dark.srcSet} sizes={dark.sizes} />
        {/* getImageProps' own props: Next's documented way to put an optimized image in <picture>. */}
        <img
          {...light}
          alt={alt}
          className="absolute block h-auto max-w-none"
          style={{
            ...light.style,
            width: `${100 / crop.w}%`,
            left: `${(-crop.x * 100) / crop.w}%`,
            top: `${(-crop.y * 100) / crop.h}%`,
          }}
        />
      </picture>
    </div>
  );
}

/** `sizes` with every width in it multiplied by `k`: "(min-width: 1024px) 50vw, 100vw" × 2. */
export function scaleSizes(sizes: string, k: number): string {
  return sizes
    .split(",")
    .map((entry) => {
      // A media condition, "(min-width: 1024px)", stays as it is; only the width after it scales.
      const [, condition = "", size = ""] = /^(\s*\([^)]*\)\s*)?(.*)$/.exec(entry) ?? [];
      const scaled = size.replace(/(\d+(?:\.\d+)?)(px|vw)/g, (_, n: string, unit: string) => {
        return `${Math.round(Number(n) * k * 100) / 100}${unit}`;
      });
      return `${condition}${scaled}`;
    })
    .join(",");
}
