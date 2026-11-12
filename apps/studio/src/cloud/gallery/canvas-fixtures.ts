/*
 * The boards of the open canvas, "Quieter shop hero" in thistlewick/fernwood: an invented plant
 * shop's home hero in three takes and on a phone, a product page and a care card, with the
 * comments the thread fixtures talk about pinned where they say. The gallery draws them only
 * when asked (`&boards`, boards-pane.tsx), for the site's product shots: its references keep
 * the main pane empty, so they never depend on how the canvas package draws a board.
 */
import { type Artboard, type Doc, parseArtboardFile, type Thread } from "@ponzu/core";
import * as f from "./fixtures.ts";

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "Inter, system-ui, sans-serif";
const CREAM = "#f3efe6";
const INK = "#1f2a1f";
const MOSS = "#56704f";

/** A potted plant, drawn: the shop's "photo" wherever one goes. */
function plant(pot = "#c8754f", leaf = "#3f6b3a", light = "#7da06d"): string {
  return `<svg viewBox="0 0 200 240" width="100%" height="100%" preserveAspectRatio="xMidYMax meet">
  <ellipse cx="100" cy="226" rx="60" ry="8" fill="rgba(0,0,0,0.12)"/>
  <path d="M100 150 C 70 120, 40 90, 46 40 C 70 60, 92 100, 100 150 Z" fill="${leaf}"/>
  <path d="M100 150 C 128 112, 160 86, 164 34 C 136 58, 108 98, 100 150 Z" fill="${light}"/>
  <path d="M100 152 C 96 100, 92 60, 100 10 C 110 60, 106 100, 100 152 Z" fill="${leaf}"/>
  <path d="M100 150 C 80 130, 54 128, 30 112 C 56 104, 84 118, 100 150 Z" fill="${light}"/>
  <path d="M100 150 C 122 132, 150 132, 174 120 C 150 108, 118 120, 100 150 Z" fill="${leaf}"/>
  <path d="M58 150 H142 L132 224 H68 Z" fill="${pot}"/>
  <rect x="52" y="144" width="96" height="16" rx="3" fill="${pot}" style="filter:brightness(1.08)"/>
</svg>`;
}

function photo(style: string, plantStyle = "width:62%;height:82%"): string {
  return `<div style="${style};display:flex;align-items:flex-end;justify-content:center;background:radial-gradient(120% 90% at 50% 30%, #a9c49a 0%, #6f8f63 45%, #3e5a39 100%)"><div style="${plantStyle}">${plant()}</div></div>`;
}

const nav = (color: string, rule: string) =>
  `<div style="display:flex;align-items:center;justify-content:space-between;padding:28px 56px;border-bottom:1px solid ${rule};font:500 13px/1 ${SANS};letter-spacing:0.08em;color:${color}">
    <span style="font:600 15px/1 ${SANS};letter-spacing:0.22em">FERNWOOD</span>
    <span style="display:flex;gap:32px"><span>SHOP</span><span>CARE</span><span>JOURNAL</span><span>CART (2)</span></span>
  </div>`;

const button = (label: string, bg: string, fg: string) =>
  `<span style="display:inline-flex;align-self:flex-start;padding:16px 26px;border-radius:999px;background:${bg};color:${fg};font:600 15px/1 ${SANS}">${label}</span>`;

const heroA = `<section data-artboard data-id="ab_hero" data-name="Hero" data-x="0" data-y="0" style="width:1200px;height:760px;background:${CREAM};color:${INK}">
  ${nav(INK, "rgba(31,42,31,0.12)")}
  <div style="flex:1;display:flex;gap:48px;padding:56px">
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:28px">
      <h1 data-id="n_headline_a" style="margin:0;font:400 84px/0.98 ${SERIF};letter-spacing:-0.02em">Plants that outlive your lease</h1>
      <p style="margin:0;max-width:420px;font:400 18px/1.5 ${SANS};color:#4b5546">Hardy, slow-growing greens, potted to travel and chosen to forgive a missed watering.</p>
      ${button("Shop the collection", INK, CREAM)}
    </div>
    ${photo("width:460px;border-radius:20px;overflow:hidden")}
  </div>
</section>`;

const heroB = `<section data-artboard data-id="ab_hero_b" data-name="Hero · B" data-x="0" data-y="880" style="width:1200px;height:760px;background:#2f4a2c;color:${CREAM}">
  <div style="position:absolute;inset:0;display:flex">${photo("flex:1", "width:44%;height:86%")}</div>
  <div style="position:relative;display:flex;flex-direction:column;height:100%">
    ${nav(CREAM, "rgba(243,239,230,0.24)")}
    <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:22px;padding:56px">
      <h1 data-id="n_headline_b" style="margin:0;font:400 56px/1 ${SERIF};letter-spacing:-0.01em;max-width:420px">Slow plants, fast homes.</h1>
      ${button("Shop the collection", CREAM, INK)}
    </div>
  </div>
</section>`;

const tile = (name: string, price: string, bg: string) =>
  `<div style="flex:1;display:flex;flex-direction:column;gap:12px">
    <div style="height:360px;border-radius:14px;overflow:hidden;display:flex;align-items:flex-end;justify-content:center;background:${bg}"><div style="width:58%;height:88%">${plant()}</div></div>
    <div style="display:flex;justify-content:space-between;font:500 15px/1 ${SANS}"><span>${name}</span><span style="color:#6b7366">${price}</span></div>
  </div>`;

const heroC = `<section data-artboard data-id="ab_hero_c" data-name="Hero · C" data-x="0" data-y="1760" style="width:1200px;height:760px;background:#fbf8f1;color:${INK}">
  ${nav(INK, "rgba(31,42,31,0.12)")}
  <div style="flex:1;display:flex;flex-direction:column;gap:36px;padding:48px 56px">
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:40px">
      <h1 data-id="n_headline_c" style="margin:0;font:italic 400 92px/0.95 ${SERIF};letter-spacing:-0.03em">The quiet ones.</h1>
      <p style="margin:0 0 10px;max-width:300px;font:400 16px/1.5 ${SANS};color:#4b5546">Spring's edit: six plants that want a window and very little else.</p>
    </div>
    <div style="display:flex;gap:24px">
      ${tile("Snake plant", "$38", "#dfe6d3")}
      ${tile("ZZ plant", "$44", "#e9e1cf")}
      ${tile("Hoya", "$29", "#d9e3dc")}
    </div>
  </div>
</section>`;

const heroPhone = `<section data-artboard data-id="ab_hero_b_phone" data-name="Hero · B, phone" data-x="1280" data-y="880" style="width:390px;height:844px;background:#2f4a2c;color:${CREAM};border-radius:36px">
  <div style="position:absolute;inset:0;display:flex">${photo("flex:1", "width:64%;height:46%;margin-bottom:250px")}</div>
  <div style="position:relative;display:flex;flex-direction:column;height:100%;padding:64px 28px 40px">
    <div style="display:flex;justify-content:space-between;font:600 13px/1 ${SANS};letter-spacing:0.2em"><span>FERNWOOD</span><span>MENU</span></div>
    <div style="flex:1"></div>
    <h1 style="margin:0 0 20px;font:400 40px/1.02 ${SERIF}">Slow plants, fast homes.</h1>
    ${button("Shop the collection", CREAM, INK)}
  </div>
</section>`;

const product = `<section data-artboard data-id="ab_product" data-name="Product · Snake plant" data-x="0" data-y="0" style="width:1200px;height:760px;background:${CREAM};color:${INK}">
  ${nav(INK, "rgba(31,42,31,0.12)")}
  <div style="flex:1;display:flex;gap:56px;padding:56px">
    ${photo("width:520px;border-radius:20px;overflow:hidden")}
    <div style="flex:1;display:flex;flex-direction:column;gap:20px;justify-content:center">
      <span style="font:500 13px/1 ${SANS};letter-spacing:0.12em;color:${MOSS}">LOW LIGHT · EASY CARE</span>
      <h1 style="margin:0;font:400 60px/1 ${SERIF}">Snake plant</h1>
      <p style="margin:0;font:400 17px/1.5 ${SANS};color:#4b5546">Upright, architectural and nearly impossible to kill. Water when the soil is dry all the way down.</p>
      <span style="font:500 24px/1 ${SANS}">$38</span>
      ${button("Add to cart", INK, CREAM)}
    </div>
  </div>
</section>`;

const care = `<section data-artboard data-id="ab_care" data-name="Care card · Hoya" data-x="0" data-y="0" style="width:600px;height:800px;background:#fbf8f1;color:${INK};padding:48px">
  <span style="font:600 13px/1 ${SANS};letter-spacing:0.22em">FERNWOOD</span>
  <div style="height:300px;margin:32px 0;border-radius:16px;overflow:hidden;display:flex">${photo("flex:1", "width:50%;height:86%")}</div>
  <h1 style="margin:0 0 20px;font:400 48px/1 ${SERIF}">Hoya</h1>
  <div style="display:flex;flex-direction:column;gap:14px;font:400 16px/1.4 ${SANS};color:#4b5546">
    <span><b style="color:${INK}">Light.</b> Bright, never harsh.</span>
    <span><b style="color:${INK}">Water.</b> Every two weeks; less in winter.</span>
    <span><b style="color:${INK}">Tip.</b> It flowers once it feels at home. Don't move it.</span>
  </div>
</section>`;

function board(html: string, name: string): Artboard {
  const id = /data-id="([^"]+)"/.exec(html)![1]!;
  return parseArtboardFile(html, { id, name }).artboard;
}

const author = (p: typeof f.ada) => ({
  kind: "user" as const,
  id: p.id,
  name: p.name,
  ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}),
});

const pin = (
  id: string,
  artboardId: string,
  x: number,
  y: number,
  who: typeof f.ada,
  text: string,
): Thread => ({
  id,
  artboardId,
  x,
  y,
  status: "open",
  createdAt: f.NOW - 30 * 60_000,
  updatedAt: f.NOW - 30 * 60_000,
  messages: [{ id: `${id}_1`, author: author(who), text, createdAt: f.NOW - 30 * 60_000 }],
});

/** The comment the thread's picture shows (thread-fixtures.ts): Ada's, by A's headline. */
const words = pin(
  "th_words",
  "ab_hero",
  300,
  250,
  f.ada,
  "Too many words here. Calmer, and put a quieter take beside it.",
);
/** The team's comments, as the team thread tells them. */
const teamPins = [
  words,
  pin("th_photo", "ab_hero_b", 760, 300, f.sam, "The photo should lead here, not the headline."),
  pin("th_serif", "ab_hero_c", 680, 140, f.maya, "Can C try the serif at a smaller size?"),
];

function doc(threads: Thread[]): Doc {
  return {
    name: "Quieter shop hero",
    pages: [
      {
        id: "pg_home",
        name: "Home",
        icon: "home",
        artboards: [
          board(heroA, "Hero"),
          board(heroB, "Hero · B"),
          board(heroC, "Hero · C"),
          board(heroPhone, "Hero · B, phone"),
        ],
      },
      { id: "pg_product", name: "Product", icon: "card", artboards: [board(product, "Product")] },
      { id: "pg_care", name: "Care cards", icon: "list", artboards: [board(care, "Care card")] },
    ],
    tokens: "",
    threads,
    notes: {},
  };
}

/** Ada alone on the canvas: her one comment. */
export const heroBoards = doc([words]);
/** With the team: Sam's and Maya's comments too. */
export const teamHeroBoards = doc(teamPins);
