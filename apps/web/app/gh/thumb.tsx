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

/** A board's position sits on its opening `<section>` tag, well inside its first kilobyte. */
const HEAD_BYTES = 1024;

/** Its canvas position, from the head of the file; null when the head doesn't say. */
function position(head: string): { x: number; y: number } | null {
  const tag = /<section\b[^>]*>/i.exec(head)?.[0];
  if (!tag) return null;
  const num = (name: string) => Number(new RegExp(`\\b${name}="(-?[\\d.]+)"`).exec(tag)?.[1]);
  const x = num("data-x");
  const y = num("data-y");
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function load(thumb: NonNullable<ListedDesign["thumb"]>): Promise<Loaded | null> {
  const key = `${thumb.base}:${thumb.boards.join(",")}`;
  let hit = cache.get(key);
  if (!hit) {
    const url = (path: string) =>
      `${thumb.base}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const get = (path: string, init?: RequestInit) =>
      fetch(url(path), init).then((r) =>
        r.ok ? r.text() : Promise.reject(new Error(String(r.status))),
      );
    // Find the top-left board from each file's head (raw GitHub answers ranges), so a page of
    // many boards costs a kilobyte each, then read only that one in full.
    const pick =
      thumb.boards.length === 1
        ? Promise.resolve(thumb.boards[0]!)
        : Promise.all(
            thumb.boards.map((b) =>
              get(b, { headers: { range: `bytes=0-${HEAD_BYTES - 1}` } })
                .then(position)
                .catch(() => null),
            ),
          ).then((spots) => {
            const at = spots
              .map((p, i) => ({ p, i }))
              .filter((s): s is { p: { x: number; y: number }; i: number } => s.p !== null)
              .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x)[0];
            return thumb.boards[at?.i ?? 0]!;
          });
    hit = Promise.all([
      pick.then((path) => get(path).then((html) => ({ path, html }))),
      thumb.tokens ? get("tokens.css").catch(() => "") : "",
    ])
      .then(([{ path, html }, tokens]) => {
        const name = path
          .split("/")
          .pop()!
          .replace(/\.html$/, "");
        return { board: parseArtboardFile(html, { id: "ab_thumb", name }).artboard, tokens };
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
