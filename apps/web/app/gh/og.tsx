import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Icons } from "@ponzu/react/icons";
import { SLICE, SLICE_STROKE } from "@ponzu/react/slice";
import { createElement, type ReactElement } from "react";
import type { DesignView } from "./github";

/*
 * A design's share card, 1200×630, as designed in .context/github-viewer.design (Share › OG card):
 * the repo, the design's name in Funnel Display, its pages with their icons, and the lockup, on
 * warm paper with a faint yuzu glow. On the right, bleeding off the edge, the canvas preview
 * Ponzu draws when the repo committed one; otherwise a field of slices with a yuzu one rising,
 * the footer's sign-off, rather than a picture that pretends to be the design.
 *
 * Satori draws it (next/og): flexbox only, and fonts as TTF.
 */

export const OG_SIZE = { width: 1200, height: 630 };

const INK = "#111110";
const MUTED = "#5e5b54";
const FAINT = "#807c73";
const PAPER = "#fbfaf7";
const CANVAS = "#f4f3ef";
const YUZU = "#ffc81e";
const FIELD = "#e4e1d9";

const font = (file: string) => readFile(join(process.cwd(), "assets/og", file));

/** Latin subsets of the site's faces (apps/web/assets/og), read once. */
const fonts = Promise.all([
  font("Inter-Regular.ttf"),
  font("Inter-Medium.ttf"),
  font("FunnelDisplay-SemiBold.ttf"),
  font("FunnelDisplay-Bold.ttf"),
  font("IBMPlexMono-Regular.ttf"),
]).then(([inter, interMedium, display, displayBold, mono]) => [
  { name: "Inter", data: inter, weight: 400 as const, style: "normal" as const },
  { name: "Inter", data: interMedium, weight: 500 as const, style: "normal" as const },
  { name: "Funnel Display", data: display, weight: 600 as const, style: "normal" as const },
  { name: "Funnel Display", data: displayBold, weight: 700 as const, style: "normal" as const },
  { name: "IBM Plex Mono", data: mono, weight: 400 as const, style: "normal" as const },
]);

export function ogFonts() {
  return fonts;
}

/** The left column is 406px wide; Funnel Display runs about half an em a character. */
function titleSize(name: string): { size: number; lines: number } {
  for (const size of [92, 76, 64]) {
    const lines = Math.ceil((name.length * 0.5 * size) / 406);
    if (lines <= 1 || (size === 64 && lines <= 2)) return { size, lines };
    if (size === 76 && lines <= 2 && name.includes(" ")) return { size, lines };
  }
  return { size: 64, lines: 2 };
}

export function OgCard({ design }: { design: DesignView }): ReactElement {
  const { repo, name, doc, preview } = design;
  const title = titleSize(name);
  // What's left between the title and the lockup, in 36px rows.
  const room = Math.floor(
    (630 - 60 - 36 - 34 - title.size * 0.95 * title.lines - 30 - 91 - 24) / 36,
  );
  const pages = doc.pages.filter((p) => p.artboards.length > 0 || doc.pages.length === 1);
  const shown = pages.length > room ? pages.slice(0, Math.max(room - 1, 1)) : pages;
  const more = pages.length - shown.length;
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        position: "relative",
        background: PAPER,
        color: INK,
        fontFamily: "Inter",
        overflow: "hidden",
      }}
    >
      {/* biome-ignore lint/performance/noImgElement: Satori draws <img>, not next/image. */}
      <img
        alt=""
        src={glow()}
        width={1200}
        height={630}
        style={{ position: "absolute", left: 0, top: 0 }}
      />
      <div
        style={{
          display: "flex",
          position: "absolute",
          left: 520,
          top: 64,
          width: 760,
          height: 566,
          borderRadius: "18px 0 0 0",
          background: CANVAS,
          boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 30px 80px rgba(60,40,0,0.18)",
          overflow: "hidden",
        }}
      >
        {preview ? (
          // biome-ignore lint/performance/noImgElement: Satori draws <img>, not next/image.
          <img
            alt=""
            src={preview}
            width={840}
            height={525}
            style={{ position: "absolute", left: -40, top: -28, objectFit: "cover" }}
          />
        ) : (
          // biome-ignore lint/performance/noImgElement: Satori draws <img>, not next/image.
          <img alt="" src={field()} width={760} height={566} />
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          position: "relative",
          width: 470,
          height: "100%",
          padding: "60px 0 56px 64px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 22,
            fontWeight: 500,
            lineHeight: 1,
            color: MUTED,
          }}
        >
          {/* biome-ignore lint/performance/noImgElement: Satori draws <img>, not next/image. */}
          <img
            alt=""
            src={avatar(repo.ownerAvatar)}
            width={36}
            height={36}
            style={{ borderRadius: 9, background: "#e8e6e0" }}
          />
          <span style={{ display: "flex" }}>
            {repo.owner} / {repo.repo}
          </span>
        </div>
        <div
          style={{
            display: "block",
            marginTop: 34,
            fontFamily: "Funnel Display",
            fontWeight: 600,
            fontSize: title.size,
            lineHeight: 0.95,
            letterSpacing: "-0.04em",
            lineClamp: 2,
          }}
        >
          {name}
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginTop: 30,
            fontSize: 24,
            lineHeight: 1,
            color: MUTED,
          }}
        >
          {shown.map((p) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <PageIcon name={p.icon} />
              <span style={{ display: "flex" }}>{p.name}</span>
            </div>
          ))}
          {more > 0 ? (
            <div style={{ display: "flex", paddingLeft: 40, color: FAINT }}>
              {`and ${more} more`}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", flex: 1 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontFamily: "Funnel Display",
            fontWeight: 700,
            fontSize: 30,
            lineHeight: 1,
            letterSpacing: "-0.05em",
          }}
        >
          <SliceMark size={35} color={INK} />
          <span style={{ display: "flex", marginTop: -2 }}>ponzu</span>
          <span
            style={{
              display: "flex",
              marginLeft: 6,
              fontFamily: "IBM Plex Mono",
              fontWeight: 400,
              fontSize: 19,
              letterSpacing: 0,
              color: FAINT,
            }}
          >
            ponzu.design
          </span>
        </div>
      </div>
    </div>
  );
}

/** A page's icon as the canvas draws it (packages/react/src/icons.tsx), in hugeicons' strokes. */
function PageIcon({ name }: { name?: string }) {
  const icon = Icons[(name && name in Icons ? name : "board") as keyof typeof Icons];
  return (
    <svg width={26} height={26} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {icon.map(([tag, attrs]) => {
        const { key, ...rest } = attrs as Record<string, string>;
        return createElement(tag, { key, ...rest, stroke: FAINT });
      })}
    </svg>
  );
}

function SliceMark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g fill={color} stroke={color} strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

function svg(body: string, w: number, h: number) {
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(doc).toString("base64")}`;
}

/** The site card's glow: yuzu from the top right, and a little from the bottom left. */
function glow() {
  return svg(
    `<defs><radialGradient id="a" cx="1200" cy="0" r="1" gradientTransform="translate(1200 0) scale(720 504) translate(-1200 0)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${YUZU}" stop-opacity="0.22"/><stop offset="0.7" stop-color="${YUZU}" stop-opacity="0"/></radialGradient><radialGradient id="b" cx="0" cy="630" r="1" gradientTransform="translate(0 630) scale(600 378) translate(0 -630)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${YUZU}" stop-opacity="0.12"/><stop offset="0.7" stop-color="${YUZU}" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="630" fill="url(#a)"/><rect width="1200" height="630" fill="url(#b)"/>`,
    1200,
    630,
  );
}

/**
 * The footer's sign-off (components/footer.tsx) on the canvas: a field of tiny slices with a
 * huge yuzu one rising from the bottom edge, centred on the card's visible part of the panel.
 */
function field() {
  const W = 760;
  const H = 566;
  const CELL = 12;
  const cx = 340;
  const R = H * 0.66;
  const GAP = R * 0.13;
  const inSlice = (x: number, y: number) => {
    const dx = x - cx;
    const dy = y - H;
    if (Math.hypot(dx, dy) > R) return false;
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    const k = Math.floor((((a + 90) % 360) + 360) / 60) % 6;
    return [k, k + 1].every((side) => {
      const r = ((-90 + 60 * side) * Math.PI) / 180;
      return Math.abs(-Math.sin(r) * dx + Math.cos(r) * dy) >= GAP / 2;
    });
  };
  const unit = CELL * 0.82;
  const units: string[] = [];
  for (let y = CELL / 2; y < H; y += CELL)
    for (let x = CELL / 2; x < W; x += CELL) {
      const on = inSlice(x, y);
      // Faded in from the top, so the slice comes up out of the canvas.
      const t = Math.min(1, Math.max(0, (y / H - 0.1) / 0.8));
      const opacity = on ? 0.55 + 0.45 * t : 0.08 + 0.72 * t;
      units.push(
        `<use href="#u" x="${(x - unit / 2).toFixed(1)}" y="${(y - unit / 2).toFixed(1)}" width="${unit.toFixed(1)}" height="${unit.toFixed(1)}" fill="${on ? YUZU : FIELD}" stroke="${on ? YUZU : FIELD}" opacity="${opacity.toFixed(2)}"/>`,
      );
    }
  const paths = SLICE.map((d) => `<path d="${d}"/>`).join("");
  return svg(
    `<defs><symbol id="u" viewBox="0 0 64 64"><g stroke-width="${SLICE_STROKE}" stroke-linejoin="round">${paths}</g></symbol></defs><rect width="${W}" height="${H}" fill="${CANVAS}"/>${units.join("")}`,
    W,
    H,
  );
}

/** GitHub serves avatars at any size; 80px is 2x the card's. */
function avatar(url: string) {
  const u = new URL(url);
  u.searchParams.set("s", "80");
  return u.toString();
}
