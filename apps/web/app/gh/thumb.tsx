"use client";

import { type Artboard, parseArtboardFile } from "@ponzu/core";
import { ArtboardView } from "@ponzu/react";
import { useEffect, useRef, useState } from "react";
import { useSystemTheme } from "./design-canvas";
import type { ListedDesign } from "./github";

/*
 * A repo index card's picture: the design's first artboard, live, drawn by the canvas's own
 * renderer and scaled to fit. It reads two files from raw GitHub at the listing's commit (the
 * board and tokens.css), never the API, and only once the card is near the screen. Until then,
 * or when it can't, the card keeps its faint slice.
 */

type Loaded = { board: Artboard; tokens: string };

/** Each card's files, kept for the visit: the commit in the URL means they never change. */
const cache = new Map<string, Promise<Loaded | null>>();

function load(thumb: NonNullable<ListedDesign["thumb"]>): Promise<Loaded | null> {
  const key = `${thumb.base}:${thumb.boards.join(",")}`;
  let hit = cache.get(key);
  if (!hit) {
    const get = (path: string) =>
      fetch(`${thumb.base}/${path.split("/").map(encodeURIComponent).join("/")}`).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(String(r.status))),
      );
    hit = Promise.all([
      Promise.all(thumb.boards.map((b) => get(b).catch(() => null))),
      thumb.tokens ? get("tokens.css").catch(() => "") : "",
    ])
      .then(([files, tokens]) => {
        const boards = files.flatMap((html, i) => {
          if (html === null) return [];
          const name = thumb.boards[i]!.split("/")
            .pop()!
            .replace(/\.html$/, "");
          return [parseArtboardFile(html, { id: `ab_thumb${i}`, name }).artboard];
        });
        // The one that sits top-left on the canvas: highest first, then leftmost.
        const board = boards.sort((a, b) => a.y - b.y || a.x - b.x)[0];
        return board ? { board, tokens } : null;
      })
      .catch(() => null);
    cache.set(key, hit);
  }
  return hit;
}

const px = (v: string | undefined, fallback: number) =>
  v && /^\d+(\.\d+)?px$/.test(v) ? Number.parseFloat(v) : fallback;

export function DesignThumb({ thumb }: { thumb: ListedDesign["thumb"] }) {
  const box = useRef<HTMLSpanElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [fit, setFit] = useState(0);
  const theme = useSystemTheme();

  useEffect(() => {
    const el = box.current;
    if (!el || !thumb) return;
    let live = true;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        load(thumb).then((l) => live && setLoaded(l));
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [thumb]);

  const w = loaded ? px(loaded.board.root.style.width, 1440) : 0;
  const h = loaded ? px(loaded.board.root.style.height, 900) : 0;

  useEffect(() => {
    const el = box.current;
    if (!el || !w || !h) return;
    // Fits the card with a margin of canvas, as the board sits on the canvas.
    const measure = () => setFit(Math.min(el.clientWidth / w, el.clientHeight / h) * 0.84);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);

  const shown = Boolean(loaded && fit);
  return (
    <span
      ref={box}
      inert
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-300 motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
    >
      {loaded ? (
        <span
          className="absolute top-1/2 left-1/2 block shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_10px_rgba(0,0,0,0.05)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06)]"
          style={{
            width: w,
            height: h,
            transform: `translate(-50%, -50%) scale(${fit})`,
          }}
        >
          <ArtboardView
            artboard={loaded.board}
            tokens={loaded.tokens}
            assetBase={thumb!.base}
            colorScheme={theme}
          />
        </span>
      ) : null}
    </span>
  );
}
