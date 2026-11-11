import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import type { DesignPreview } from "../model.ts";
import { cn } from "../ui/cn.ts";
import { useColorScheme } from "../ui/color-scheme.ts";

/*
 * While the agent works a design's preview moves to a new address every few seconds (map.ts
 * previewOf). A new address must never show the empty tile in between, so the picture showing
 * stays until the next one has downloaded and decoded off-screen; then the new one fades in over
 * it, and the old one goes once it is covered. One that fails is skipped; one that arrives after
 * a newer one has shown is dropped, so they never go backwards. A shown picture holds for at
 * least `HOLD_MS`, so two arriving close together make one swap, not a flicker: the thumbnail
 * keeps up without churning. Light and dark swap as soon as the other's picture is in.
 *
 * The swap is a true cross-fade: the old picture fades out as the new one fades in, added with
 * plus-lighter so their opacities always sum to one. The tile never dims midway, and previews,
 * which are drawn with a clear background, never show the old one through their clear parts.
 */

/** The least time a picture shows before the next one replaces it. */
export const HOLD_MS = 1000;

/** Addresses already decoded in this window: a row drawn again starts on its picture. */
const decoded = new Set<string>();
function remember(src: string) {
  decoded.delete(src);
  decoded.add(src);
  // Oldest first; a few hundred addresses is plenty for a sidebar and its search.
  if (decoded.size > 400) decoded.delete(decoded.values().next().value as string);
}

interface Layer {
  src: string;
  /** Which ask it answers, in the order they were asked. */
  order: number;
  /** Fades in over what is beneath; the first picture of a row drawn again doesn't. */
  fade: boolean;
  scheme: "light" | "dark";
}

/**
 * The pictures stacked in the tile, oldest beneath: usually one, two while the newest fades in.
 */
function useLayers(
  src: string | null,
  scheme: "light" | "dark",
): {
  layers: Layer[];
  /** Its first picture is on its way: the visual check waits for it (scripts/visual-lib.ts). */
  loading: boolean;
  covered: (order: number) => void;
} {
  const [layers, setLayers] = useState<Layer[]>(() =>
    src && decoded.has(src) ? [{ src, order: 0, fade: false, scheme }] : [],
  );
  const asked = useRef(0);
  const top = useRef<Layer | null>(layers[0] ?? null);
  const shownAt = useRef(0);
  const waiting = useRef<Layer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  /** The last ask for no picture at all: nothing asked before it may show. */
  const cleared = useRef(0);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    const order = ++asked.current;
    if (src === null) {
      top.current = null;
      waiting.current = null;
      cleared.current = order;
      setLayers([]);
      return;
    }
    // Back to what is showing (light, dark and light again): nothing to load.
    if (top.current?.src === src) {
      top.current = { ...top.current, order, scheme };
      return;
    }
    const show = (layer: Layer) => {
      if (!alive.current) return;
      top.current = layer;
      shownAt.current = performance.now();
      // The fade's end clears what is beneath (`covered`); a hidden window's animations don't
      // run, so never keep more than the two the newest fades over.
      setLayers((now) => [...now.slice(-2), layer]);
    };
    const ready = (layer: Layer) => {
      // A newer one already showed, or is waiting its turn: this one is out of date.
      if (layer.order <= (top.current?.order ?? cleared.current)) return;
      if (layer.order <= (waiting.current?.order ?? 0)) return;
      // The same picture asked for twice: it is already the one showing.
      if (top.current?.src === layer.src) {
        top.current = { ...top.current, order: layer.order };
        return;
      }
      const wait = shownAt.current + HOLD_MS - performance.now();
      if (!top.current || wait <= 0 || top.current.scheme !== layer.scheme) return show(layer);
      waiting.current = layer;
      timer.current ??= setTimeout(() => {
        timer.current = null;
        const next = waiting.current;
        waiting.current = null;
        if (next && next.order > (top.current?.order ?? cleared.current)) show(next);
      }, wait);
    };
    const image = new Image();
    image.decoding = "async";
    image.src = src;
    image.decode().then(
      () => {
        remember(src);
        ready({ src, order, fade: true, scheme });
      },
      // Not drawn yet, or gone: keep what is showing.
      () => {
        if (alive.current) setFailed(src);
      },
    );
  }, [src, scheme]);

  /** The picture with this order is drawn and fully in: what is beneath it can go. */
  const covered = (order: number) =>
    setLayers((now) =>
      now.some((l) => l.order < order) ? now.filter((l) => l.order >= order) : now,
    );
  return { layers, loading: src !== null && !layers.length && failed !== src, covered };
}

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
  const { layers, loading, covered } = useLayers(preview?.[scheme] ?? null, scheme);
  // Drop what is beneath only once the new picture is both drawn and fully in.
  const settle = (e: SyntheticEvent<HTMLImageElement>, order: number) => {
    const img = e.currentTarget;
    if (img.complete) covered(order);
    else img.addEventListener("load", () => covered(order), { once: true });
  };
  return (
    <span
      data-slot="design-preview"
      data-status={loading ? "loading" : undefined}
      className={cn(
        "relative block shrink-0 overflow-hidden rounded-4 bg-hover shadow-preview",
        className,
      )}
      style={{ width, height }}
    >
      {layers.length ? (
        // A group of their own, so the pictures add up to one another and not to the tile.
        <span className="absolute inset-0 isolate">
          {layers.map((layer, i) => (
            <img
              key={layer.order}
              src={layer.src}
              alt=""
              draggable={false}
              // Decoded before it was placed; should it fail now, the empty tile, never a broken one.
              onError={(e) => {
                e.currentTarget.hidden = true;
              }}
              onAnimationEnd={(e) => settle(e, layer.order)}
              className={cn(
                "absolute inset-0 block size-full object-cover object-top mix-blend-plus-lighter",
                i < layers.length - 1 ? "preview-out" : layer.fade && "preview-in",
              )}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}
