/*
 * The boards the canvas benchmark draws: each one an edge case for the renderer, made the same
 * every time. Generated boards are written as HTML and read with `parseArtboardFile`, so they
 * hold only what a canvas may (core/src/rules.ts), and every node then gets an id from the
 * spec's, so two boards from one generator can share a canvas.
 *
 * Two limits shape them. One op carries at most MAX_NODES nodes, nested at most MAX_NODE_DEPTH
 * deep, in at most MAX_OP_BYTES of JSON (core/src/limits.ts), and a board is committed as one
 * op. So `deep-tree` nests as deep as an op allows, which is under 100 rather than hundreds,
 * and the densest boards style their many small nodes with classes from a `<style>` in the
 * board (scoped to it: each board draws in its own shadow root) instead of long inline styles.
 */
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { type Artboard, type PNode, parseArtboardFile } from "@ponzu/core";

export interface BoardSpec {
  id: string;
  name: string;
  x: number;
  y: number;
}

export type BoardKind =
  | "landing-weft"
  | "landing-kettle"
  | "landing-halon"
  | "site"
  | "dense-grid"
  | "deep-tree"
  | "table"
  | "text-wall"
  | "effects"
  | "animated"
  | "svg-chart"
  | "images"
  | "fit-content"
  | "huge"
  | "tiny-card";

/** Total nodes (elements + text) in a board, its root included, as `validateOp` counts them. */
export function countNodes(ab: Artboard): number {
  let n = 0;
  const walk = (node: PNode) => {
    n++;
    if (node.kind === "el") for (const child of node.children) walk(child);
  };
  walk(ab.root);
  return n;
}

/* ------------------------------------------------------------------ */
/* Making a board                                                      */
/* ------------------------------------------------------------------ */

/**
 * The longest spec id a board takes. Every node's id is the spec's, a dash and up to three
 * base-36 digits, so the spec's length is paid on each of a board's thousands of elements:
 * at 20, the densest board (`dense-grid`) still fits MAX_OP_BYTES with room to spare.
 */
export const MAX_SPEC_ID = 20;

/** A board from HTML: its section's content and style, read under the rules and re-id'd. */
function board(spec: BoardSpec, style: string, inner: string): Artboard {
  return fromFile(spec, `<section data-artboard style="${style}">${inner}</section>`);
}

function fromFile(spec: BoardSpec, html: string): Artboard {
  if (!/^[A-Za-z0-9_-]+$/.test(spec.id) || spec.id.length > MAX_SPEC_ID)
    throw new Error(`A board's id must be an id of at most ${MAX_SPEC_ID} characters: ${spec.id}`);
  const { artboard, dropped } = parseArtboardFile(html, { id: spec.id, name: spec.name });
  // A generator that writes something the rules remove is wrong about what it draws.
  if (dropped.length) throw new Error(`${spec.name} lost ${dropped.map((d) => d.what).join(", ")}`);
  let next = 0;
  const reId = (node: PNode) => {
    if (node.kind !== "el") return;
    node.id = `${spec.id}-${(next++).toString(36)}`;
    for (const child of node.children) reId(child);
  };
  reId(artboard.root);
  artboard.root.id = spec.id;
  artboard.root.name = spec.name;
  return { ...artboard, id: spec.id, name: spec.name, x: spec.x, y: spec.y };
}

/** An element as HTML. Values are ours and hold no quotes or markup, so nothing is escaped. */
function el(tag: string, style: string, inner = "", attrs: Record<string, string | number> = {}) {
  let open = `<${tag}`;
  for (const [k, v] of Object.entries(attrs)) open += ` ${k}="${v}"`;
  if (style) open += ` style="${style}"`;
  return `${open}>${inner}</${tag}>`;
}

const repeat = (n: number, f: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => f(i)).join("");

/* ------------------------------------------------------------------ */
/* Deterministic randomness                                            */
/* ------------------------------------------------------------------ */

interface Rng {
  /** In [0, 1). */
  next(): number;
  /** An integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  pick<T>(list: readonly T[]): T;
  words(n: number): string;
  sentence(min: number, max: number): string;
}

/** mulberry32, seeded from a string: the same seed gives the same board everywhere. */
function rng(seed: string): Rng {
  let a = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 0x01000193);
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  const words = (n: number) => repeat(n, (i) => (i ? " " : "") + pick(WORDS));
  const sentence = (min: number, max: number) => {
    const s = words(int(min, max));
    return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
  };
  return { next, int, pick, words, sentence };
}

const WORDS = [
  "canvas",
  "board",
  "layer",
  "frame",
  "pixel",
  "token",
  "render",
  "agent",
  "draft",
  "review",
  "the",
  "a",
  "of",
  "and",
  "to",
  "in",
  "with",
  "for",
  "on",
  "every",
  "small",
  "large",
  "quiet",
  "bright",
  "steady",
  "quick",
  "careful",
  "shared",
  "open",
  "closed",
  "north",
  "river",
  "stone",
  "paper",
  "ink",
  "signal",
  "copper",
  "linen",
  "orbit",
  "garden",
  "harbor",
  "lantern",
  "meadow",
  "ledger",
  "kettle",
  "weave",
  "thread",
  "margin",
  "column",
  "grid",
  "rhythm",
  "measure",
  "scale",
  "tempo",
  "glyph",
  "kern",
  "baseline",
  "gutter",
  "swatch",
  "palette",
  "contrast",
  "shadow",
  "light",
  "motion",
  "season",
  "window",
  "drawer",
  "button",
  "status",
  "invoice",
  "project",
  "release",
  "sprint",
  "merge",
  "branch",
  "commit",
  "deploy",
  "metric",
  "chart",
  "report",
] as const;

const PALETTE = [
  "#FF5A1F",
  "#3D5BFF",
  "#0FA38A",
  "#F0AE00",
  "#A646D6",
  "#E0382B",
  "#1F9D55",
  "#15140F",
  "#858176",
  "#DDE3FF",
  "#FFE4D8",
  "#D2F0E9",
  "#FBEFC6",
  "#F0DDF8",
  "#ECE9E1",
  "#FBFAF7",
] as const;

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

/** Where the repository's example designs are. */
const EXAMPLES = new URL("../../../examples/", import.meta.url);

function readExample(path: string): string {
  return readFileSync(new URL(path, EXAMPLES), "utf8");
}

/**
 * The examples each have their own tokens, under the same names (`--color-line` is a different
 * colour in each), and a canvas has one set. So each example's tokens are renamed under its
 * own prefix, in its tokens and its page alike.
 */
function prefixTokens(css: string, prefix: string): string {
  return css.replace(/--([A-Za-z0-9_-]+)/g, `--${prefix}-$1`);
}

/** The generated boards' own tokens. */
const BENCH_TOKENS = `:root {
  --bench-paper: #F7F5F0;
  --bench-card: #FFFFFF;
  --bench-ink: #16150F;
  --bench-ink-2: #55524A;
  --bench-ink-3: #8C887D;
  --bench-line: #E2DED3;
  --bench-accent: #FF5A1F;
  --bench-accent-2: #3D5BFF;
  --bench-ok: #1F9D55;
  --bench-radius: 10px;
  --bench-shadow: 0 1px 2px rgba(22, 21, 15, 0.06), 0 8px 24px rgba(22, 21, 15, 0.1);
  --bench-font: "Inter", system-ui, sans-serif;
  --bench-serif: "Georgia", "Times New Roman", serif;
  --bench-mono: "JetBrains Mono", ui-monospace, monospace;
}
`;

const LANDINGS = {
  "landing-weft": { design: "weft", page: "weft.design/pages/website/landing.html" },
  "landing-kettle": { design: "kettle", page: "kettle.design/pages/website/landing-desktop.html" },
  "landing-halon": { design: "halon", page: "halon.design/pages/website/landing.html" },
} as const;

/** Tokens CSS every corpus canvas should commit (union of what the boards reference). */
export const CORPUS_TOKENS: string = [
  BENCH_TOKENS,
  ...Object.values(LANDINGS).map(({ design }) =>
    prefixTokens(readExample(`${design}.design/tokens.css`), design),
  ),
].join("\n");

function landing(kind: keyof typeof LANDINGS) {
  const { design, page } = LANDINGS[kind];
  return (spec: BoardSpec) => fromFile(spec, prefixTokens(readExample(page), design));
}

/* ------------------------------------------------------------------ */
/* site: a reconstruction of a marketing site                          */
/* ------------------------------------------------------------------ */

const FONT = "font-family:var(--bench-font)";

/**
 * The mockups' styles, as classes in the site's `<style>`. Written inline on each of their
 * thousands of nodes they would take the board past MAX_OP_BYTES; each window sets its accent
 * as `--a`.
 */
const MOCKUP_SHEET = [
  ".mw{border-radius:8px;overflow:hidden;background:#fff;box-shadow:var(--bench-shadow);border:1px solid var(--bench-line);display:flex;flex-direction:column;font-size:6px;color:#16150F}",
  ".mt{display:flex;align-items:center;gap:4px;height:18px;flex-shrink:0;padding:0 8px;background:#EEECE6;border-bottom:1px solid #DDD9CF}",
  ".md{width:6px;height:6px;border-radius:50%;background:#FF5F57}.md+.md{background:#FEBC2E}.md+.md+.md{background:#28C840}",
  ".mtt{margin-left:8px;font-size:7px;color:#8C887D}",
  ".mb{flex:1;display:flex;min-height:0}",
  ".ms{width:88px;flex-shrink:0;padding:6px 4px;display:flex;flex-direction:column;gap:2px;background:#F6F4EF;border-right:1px solid #E5E1D7;overflow:hidden}",
  ".mr{display:flex;align-items:center;gap:4px;height:11px;flex-shrink:0;padding:0 4px;border-radius:3px}",
  ".mr.on{background:color-mix(in srgb,var(--a) 14%,transparent)}.mr.on .mi{background:var(--a)}",
  ".mi{width:6px;height:6px;border-radius:2px;background:#C9C4B8;flex-shrink:0}",
  ".ml{color:#55524A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".mm{flex:1;display:flex;flex-direction:column;min-width:0}",
  ".mk{display:flex;align-items:center;gap:4px;height:20px;flex-shrink:0;padding:0 6px;border-bottom:1px solid #EEE}",
  ".mq{flex:1;height:10px;border-radius:5px;background:#F1EFEA;color:#999;padding-left:4px;line-height:10px}",
  ".mn{height:12px;padding:0 5px;border-radius:3px;line-height:12px;background:#F1EFEA;color:#55524A}.mn.on{background:var(--a);color:#fff}",
  ".mc{flex:1;padding:6px;display:flex;flex-direction:column;gap:4px;overflow:hidden}",
  ".av{width:8px;height:8px;border-radius:50%;flex-shrink:0;border:1px solid #fff}.av.s{width:6px;height:6px}",
  ".bx{padding:4px;border:1px solid #EEE;border-radius:4px;background:#fff}",
  ".mu{color:#8C887D}.t5{font-size:5px}.t9{font-size:10px;font-weight:700}.b{font-weight:600}",
  ".fx{display:flex;align-items:center;gap:3px}.f1{flex:1;min-width:0;white-space:nowrap;overflow:hidden}",
  ".rw{display:flex;align-items:center;gap:4px;height:12px;flex-shrink:0;border-bottom:1px solid #F3F3F3}",
  ".br{height:3px;border-radius:2px;background:var(--a)}",
  ".bar{flex:1;background:var(--a);opacity:.8;border-radius:1px 1px 0 0}",
  ".hm{display:grid;grid-template-columns:repeat(24,1fr);gap:1px}.hm i{height:5px;border-radius:1px;background:var(--a)}",
  ".dt{width:5px;height:5px;border-radius:50%;flex-shrink:0;background:var(--a)}",
  ".tg{padding:0 2px;border-radius:2px;background:#F1EFEA}",
  ".col{flex:1;display:flex;flex-direction:column;gap:3px;padding:3px;background:#F6F4EF;border-radius:4px;min-width:0}",
  ".cd{padding:3px;background:#fff;border-radius:3px;box-shadow:0 1px 1px rgba(0,0,0,.06)}",
  ".tile{border-radius:4px;overflow:hidden;border:1px solid #EEE}",
].join("");

const div = (cls: string, inner = "", style = "") => el("div", style, inner, { class: cls });
const span = (cls: string, text: string, style = "") => el("span", style, text, { class: cls });
const bare = (tag: string, cls: string, style = "") => el(tag, style, "", { class: cls });

/** A small app window, dense with tiny DOM: the kind of picture a site shows of its product. */
function mockup(r: Rng, variant: number, w: number, h: number): string {
  const avatar = (small = false) =>
    bare("i", small ? "av s" : "av", `background:${r.pick(PALETTE)}`);
  const titlebar = div("mt", repeat(3, () => bare("i", "md")) + span("mtt", r.words(2)));
  const sidebar = div(
    "ms",
    repeat(28, (i) =>
      div(i === 2 ? "mr on" : "mr", bare("i", "mi") + span("ml", r.words(i % 5 ? 1 : 2))),
    ),
  );
  const toolbar = div(
    "mk",
    div("mq", "Search") + repeat(6, (i) => div(i === 5 ? "mn on" : "mn", r.words(1))),
  );
  const listRow = () =>
    div(
      "rw",
      bare("i", "dt") +
        avatar() +
        span("f1 b", r.words(2)) +
        span("f1", r.sentence(3, 6)) +
        span("mu", `${r.int(1, 59)}m`),
    );
  let body: string;
  switch (variant % 4) {
    case 0: // A dashboard: stats, a bar chart, a heatmap and a list.
      body =
        el(
          "div",
          "display:grid;grid-template-columns:repeat(4,1fr);gap:4px",
          repeat(4, () =>
            div(
              "bx",
              span("mu t5", r.words(2)) +
                div("t9", `${r.int(10, 999)}k`) +
                bare("div", "br", `width:${r.int(20, 100)}%`),
            ),
          ),
        ) +
        el(
          "div",
          "display:flex;align-items:flex-end;gap:1px;height:50px;flex-shrink:0",
          repeat(56, () => bare("i", "bar", `height:${r.int(10, 100)}%`)),
          { class: "bx" },
        ) +
        div(
          "hm",
          repeat(264, () => bare("i", "", `opacity:${(r.next() * 0.9 + 0.1).toFixed(1)}`)),
        ) +
        repeat(14, listRow);
      break;
    case 1: // A kanban board.
      body = el(
        "div",
        "display:flex;gap:4px;flex:1;min-height:0",
        repeat(4, () =>
          div(
            "col",
            span("b", r.words(1)) +
              repeat(10, () =>
                div(
                  "cd",
                  div("t5", r.words(4)) +
                    div(
                      "fx",
                      span("tg t5", r.words(1)) +
                        bare("i", "f1") +
                        avatar(true) +
                        avatar(true) +
                        avatar(true),
                    ),
                ),
              ),
          ),
        ),
      );
      break;
    case 2: // An inbox, with a preview pane.
      body = el(
        "div",
        "display:flex;gap:4px;flex:1;min-height:0",
        el("div", "flex:3;min-width:0;overflow:hidden", repeat(34, listRow)) +
          el(
            "div",
            "flex:2;min-width:0;overflow:hidden",
            div("fx", avatar() + span("b", r.words(2))) +
              repeat(10, () =>
                el(
                  "p",
                  "margin:3px 0",
                  r.sentence(8, 14) + " " + el("b", "", r.words(2)) + " " + r.sentence(4, 8),
                ),
              ),
          ),
      );
      break;
    default: // A gallery of tiles.
      body = el(
        "div",
        "display:grid;grid-template-columns:repeat(6,1fr);gap:4px",
        repeat(42, () =>
          div(
            "tile",
            bare(
              "div",
              "",
              `height:26px;background:linear-gradient(${r.int(0, 360)}deg,${r.pick(PALETTE)},${r.pick(PALETTE)})`,
            ) + div("fx", avatar(true) + span("f1 t5", r.words(2)) + bare("i", "dt")),
          ),
        ),
      );
  }
  return div(
    "mw",
    titlebar + div("mb", sidebar + div("mm", toolbar + div("mc", body))),
    `width:${w}px;height:${h}px;--a:${PALETTE[variant % 7]}`,
  );
}

function icon(r: Rng, size: number, color: string): string {
  const d = r.pick([
    "M4 12h16M12 4v16",
    "M5 5l14 14M19 5L5 19",
    "M12 3l9 18H3z",
    "M4 6h16v12H4z",
    "M12 2a10 10 0 1 0 0.01 0",
    "M3 12l6 6L21 6",
  ]);
  return el(
    "svg",
    "display:block;flex-shrink:0",
    el("path", "", "", {
      d,
      stroke: color,
      "stroke-width": 2,
      fill: "none",
      "stroke-linecap": "round",
    }),
    { width: size, height: size, viewBox: "0 0 24 24" },
  );
}

function site(spec: BoardSpec): Artboard {
  const r = rng("site");
  const section = (style: string, inner: string) => el("div", `padding:0 80px;${style}`, inner);
  const h2 = (text: string) =>
    el("h2", "margin:0 0 12px;font-size:48px;letter-spacing:-0.02em;font-weight:700", text);
  const lede = (text: string) =>
    el("p", "margin:0 0 40px;font-size:18px;color:var(--bench-ink-2);max-width:640px", text);
  const button = (text: string, primary: boolean) =>
    el(
      "a",
      `display:inline-flex;align-items:center;height:44px;padding:0 20px;border-radius:999px;font-weight:600;text-decoration:none;${primary ? "background:var(--bench-ink);color:#fff" : "border:1px solid var(--bench-line);color:var(--bench-ink)"}`,
      text,
      { href: "#" },
    );

  const nav = section(
    "display:flex;align-items:center;gap:32px;height:72px;border-bottom:1px solid var(--bench-line)",
    el(
      "div",
      "display:flex;align-items:center;gap:8px;font-weight:800;font-size:20px",
      icon(r, 24, "#FF5A1F") + "Ponzu",
    ) +
      repeat(6, () =>
        el("a", "color:var(--bench-ink-2);text-decoration:none;font-size:14px", r.words(1), {
          href: "#",
        }),
      ) +
      el("div", "flex:1") +
      button("Sign in", false) +
      button("Download", true),
  );

  const hero = section(
    "height:900px;padding-top:96px;text-align:center;background:radial-gradient(1200px 600px at 50% 0%,#FFE4D8,transparent)",
    el(
      "div",
      "display:inline-block;padding:4px 12px;border-radius:999px;background:#fff;border:1px solid var(--bench-line);font-size:13px;margin-bottom:24px",
      r.sentence(4, 6),
    ) +
      el(
        "h1",
        "margin:0 auto 20px;font-size:88px;line-height:1;letter-spacing:-0.04em;max-width:1000px",
        r.sentence(5, 7),
      ) +
      el(
        "p",
        "margin:0 auto 32px;font-size:20px;color:var(--bench-ink-2);max-width:680px",
        r.sentence(18, 26),
      ) +
      el(
        "div",
        "display:flex;gap:12px;justify-content:center;margin-bottom:56px",
        button("Download for Mac", true) + button("Watch the film", false),
      ) +
      el("div", "display:flex;justify-content:center", mockup(r, 0, 1100, 520)),
  );

  const logos = section(
    "height:160px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--bench-line);border-bottom:1px solid var(--bench-line)",
    repeat(12, () =>
      el(
        "div",
        "display:flex;align-items:center;gap:6px;font-weight:700;color:var(--bench-ink-3);font-size:15px",
        icon(r, 18, "#8C887D") + r.words(1),
      ),
    ),
  );

  const grid = section(
    "padding-top:120px;padding-bottom:120px",
    h2(r.sentence(4, 6)) +
      lede(r.sentence(16, 24)) +
      el(
        "div",
        "display:grid;grid-template-columns:repeat(3,1fr);gap:32px",
        repeat(12, (i) =>
          el(
            "figure",
            "margin:0",
            mockup(r, i, 405, 270) +
              el(
                "figcaption",
                "margin-top:10px;font-size:14px;color:var(--bench-ink-2)",
                el("b", "color:var(--bench-ink)", r.words(2)) + ` ${r.sentence(6, 10)}`,
              ),
          ),
        ),
      ),
  );

  const features = section(
    "padding-top:120px;padding-bottom:120px;background:var(--bench-card)",
    h2(r.sentence(3, 5)) +
      lede(r.sentence(14, 20)) +
      el(
        "div",
        "display:grid;grid-template-columns:repeat(3,1fr);gap:24px",
        repeat(9, () =>
          el(
            "div",
            "padding:28px;border-radius:var(--bench-radius);border:1px solid var(--bench-line);background:var(--bench-paper)",
            el(
              "div",
              `width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:16px;background:${r.pick(PALETTE)}22`,
              icon(r, 20, r.pick(PALETTE)),
            ) +
              el("h3", "margin:0 0 8px;font-size:20px", r.sentence(2, 4)) +
              el(
                "p",
                "margin:0;font-size:15px;line-height:1.5;color:var(--bench-ink-2)",
                r.sentence(14, 22),
              ) +
              el(
                "a",
                "display:inline-block;margin-top:12px;font-size:14px;color:var(--bench-accent)",
                "Learn more",
                { href: "#" },
              ),
          ),
        ),
      ),
  );

  const quotes = section(
    "padding-top:120px;padding-bottom:120px",
    h2(r.sentence(3, 5)) +
      el(
        "div",
        "display:grid;grid-template-columns:repeat(3,1fr);gap:24px",
        repeat(6, () =>
          el(
            "blockquote",
            "margin:0;padding:24px;border-radius:var(--bench-radius);background:var(--bench-card);box-shadow:var(--bench-shadow)",
            el(
              "p",
              "margin:0 0 16px;font-family:var(--bench-serif);font-size:18px;line-height:1.5",
              `“${r.sentence(18, 30)}”`,
            ) +
              el(
                "div",
                "display:flex;align-items:center;gap:10px",
                el("i", `width:36px;height:36px;border-radius:50%;background:${r.pick(PALETTE)}`) +
                  el(
                    "div",
                    "",
                    el("div", "font-weight:600;font-size:14px", r.words(2)) +
                      el("div", "font-size:13px;color:var(--bench-ink-3)", r.words(3)),
                  ),
              ),
          ),
        ),
      ),
  );

  const pricing = section(
    "padding-top:120px;padding-bottom:120px;background:var(--bench-card)",
    h2("Pricing") +
      el(
        "div",
        "display:grid;grid-template-columns:repeat(3,1fr);gap:24px",
        repeat(3, (i) =>
          el(
            "div",
            `padding:32px;border-radius:16px;border:1px solid var(--bench-line);${i === 1 ? "background:var(--bench-ink);color:#fff" : "background:var(--bench-paper)"}`,
            el("div", "font-size:15px;font-weight:600", r.words(1)) +
              el("div", "font-size:56px;font-weight:800;margin:12px 0", `$${i * 20}`) +
              el(
                "ul",
                "list-style:none;margin:0 0 24px;padding:0;display:flex;flex-direction:column;gap:10px",
                repeat(9, () =>
                  el(
                    "li",
                    "display:flex;gap:8px;font-size:14px",
                    icon(r, 16, "#1F9D55") + r.sentence(3, 6),
                  ),
                ),
              ) +
              button(i === 1 ? "Start a trial" : "Get started", i !== 1),
          ),
        ),
      ),
  );

  const cta = section(
    "height:480px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:linear-gradient(135deg,#15140F,#2E2D28);color:#fff",
    el("h2", "margin:0 0 24px;font-size:64px;letter-spacing:-0.03em", r.sentence(4, 6)) +
      el(
        "a",
        "display:inline-flex;align-items:center;height:52px;padding:0 28px;border-radius:999px;background:var(--bench-accent);color:#fff;text-decoration:none;font-weight:700",
        "Download Ponzu",
        { href: "#" },
      ),
  );

  // The footer is the board's long tail: many link columns, a sitemap, legal rows and icons.
  const footer = section(
    "padding-top:96px;padding-bottom:64px;background:#0F0E0B;color:#B9B5AA;font-size:13px",
    el(
      "div",
      "display:grid;grid-template-columns:2fr repeat(8,1fr);gap:24px;margin-bottom:64px",
      el(
        "div",
        "",
        el(
          "div",
          "display:flex;align-items:center;gap:8px;font-weight:800;font-size:22px;color:#fff;margin-bottom:16px",
          icon(r, 24, "#FF5A1F") + "Ponzu",
        ) +
          el("p", "margin:0 0 16px;line-height:1.5", r.sentence(12, 18)) +
          el(
            "div",
            "display:flex;gap:6px",
            el(
              "div",
              "flex:1;height:36px;border-radius:8px;background:#1C1B17;border:1px solid #2E2D28;padding:0 10px;line-height:36px;color:#6F6C63",
              "you@example.com",
            ) +
              el(
                "div",
                "height:36px;padding:0 14px;border-radius:8px;background:#fff;color:#000;line-height:36px;font-weight:600",
                "Subscribe",
              ),
          ),
      ) +
        repeat(8, () =>
          el(
            "div",
            "display:flex;flex-direction:column;gap:9px",
            el("div", "color:#fff;font-weight:600;margin-bottom:4px", r.words(1)) +
              repeat(16, () =>
                el("a", "color:#B9B5AA;text-decoration:none", r.words(r.int(1, 3)), { href: "#" }),
              ),
          ),
        ),
    ) +
      el(
        "div",
        "display:grid;grid-template-columns:repeat(10,1fr);gap:6px 16px;padding:32px 0;border-top:1px solid #2E2D28",
        repeat(220, () =>
          el(
            "a",
            "color:#8E8B81;text-decoration:none;font-size:11px;white-space:nowrap;overflow:hidden",
            r.words(2),
            { href: "#" },
          ),
        ),
      ) +
      repeat(4, () =>
        el(
          "div",
          "display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;padding:16px 0;border-top:1px solid #2E2D28;font-size:11px",
          el("span", "color:#6F6C63", `© 2026 ${r.words(2)}`) +
            repeat(18, () =>
              el("a", "color:#8E8B81;text-decoration:none", r.words(r.int(1, 2)), { href: "#" }),
            ),
        ),
      ) +
      el(
        "div",
        "display:flex;align-items:center;gap:14px;padding:24px 0;border-top:1px solid #2E2D28",
        repeat(16, () =>
          el(
            "a",
            "display:flex;width:28px;height:28px;border-radius:50%;background:#1C1B17;align-items:center;justify-content:center",
            icon(r, 14, "#B9B5AA"),
            { href: "#" },
          ),
        ) +
          el("div", "flex:1") +
          el("div", "padding:6px 10px;border:1px solid #2E2D28;border-radius:6px", "English (US)"),
      ) +
      el(
        "div",
        "font-size:220px;font-weight:900;letter-spacing:-0.06em;line-height:1;color:#1C1B17;margin-top:32px",
        "ponzu",
      ),
  );

  return board(
    spec,
    `width:1440px;height:7800px;overflow:hidden;background:var(--bench-paper);color:var(--bench-ink);${FONT}`,
    el("style", "", MOCKUP_SHEET) +
      nav +
      hero +
      logos +
      grid +
      features +
      quotes +
      pricing +
      cta +
      footer,
  );
}

/* ------------------------------------------------------------------ */
/* dense-grid: thousands of tiny absolutely positioned boxes           */
/* ------------------------------------------------------------------ */

function denseGrid(spec: BoardSpec): Artboard {
  const cols = 100;
  const rows = 80;
  const cell = 14;
  // Each box carries only its place and a colour class: inline styles on 8,000 boxes would
  // take the op past MAX_OP_BYTES.
  const sheet = el(
    "style",
    "",
    `.g i{position:absolute;top:0;width:${cell - 1}px;height:${cell - 1}px;border-radius:2px}${PALETTE.map((c, i) => `.c${i.toString(16)}{background:${c}}`).join("")}`,
  );
  const rowsHtml = repeat(rows, (y) =>
    el(
      "div",
      `position:absolute;left:0;top:${y * cell}px`,
      repeat(cols, (x) => {
        // A plasma, quantised to the palette: pixel art with structure, not noise.
        const v =
          Math.sin(x / 7) +
          Math.sin(y / 5) +
          Math.sin((x + y) / 11) +
          Math.sin(Math.hypot(x - 50, y - 40) / 6);
        const c = Math.min(15, Math.max(0, Math.floor(((v + 4) / 8) * 16)));
        return el("i", `left:${x * cell}px`, "", { class: `c${c.toString(16)}` });
      }),
    ),
  );
  return board(
    spec,
    "width:1440px;height:1160px;background:#0F0E0B",
    sheet +
      el("div", "position:absolute;left:20px;top:20px;width:1400px;height:1120px", rowsHtml, {
        class: "g",
      }),
  );
}

/* ------------------------------------------------------------------ */
/* deep-tree: nesting as deep as one op allows                         */
/* ------------------------------------------------------------------ */

/**
 * Levels in each spine. The board's root is level 1 of MAX_NODE_DEPTH (100), the spines'
 * wrapper level 2, and every level's text one below it, so 96 is as deep as a board goes.
 */
const DEEP_LEVELS = 96;

function deepTree(spec: BoardSpec): Artboard {
  const r = rng("deep-tree");
  const spine = (s: number) => {
    let inner = el("span", "font-size:9px", "leaf");
    for (let level = DEEP_LEVELS - 2; level >= 0; level--) {
      const row = level % 2 === 0;
      inner = el(
        "div",
        `display:flex;flex-direction:${row ? "row" : "column"};gap:1px;padding:1px;border:1px solid hsl(${(level * 7 + s * 90) % 360} 60% 60%);border-radius:2px;min-width:0`,
        el(
          "span",
          "font-size:8px;color:#55524A;flex-shrink:0",
          `${level}${r.pick(["a", "b", "c"])}`,
        ) + inner,
      );
    }
    return inner;
  };
  return board(
    spec,
    `width:1440px;height:1000px;overflow:hidden;background:#fff;${FONT}`,
    el(
      "div",
      "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px",
      repeat(4, spine),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* table                                                               */
/* ------------------------------------------------------------------ */

function table(spec: BoardSpec): Artboard {
  const r = rng("table");
  const heads = [
    "#",
    "Customer",
    "Plan",
    "Seats",
    "MRR",
    "Status",
    "Region",
    "Owner",
    "Renewal",
    "Health",
  ];
  const status = ["Active", "Trial", "Past due", "Paused"];
  const sheet = el(
    "style",
    "",
    "table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:4px 8px;border-bottom:1px solid var(--bench-line);text-align:left;white-space:nowrap}th{position:sticky;top:0;background:var(--bench-paper);font-weight:600}tr:nth-child(even) td{background:#FAF9F5}.n{text-align:right;font-variant-numeric:tabular-nums}.b{padding:1px 6px;border-radius:999px;font-size:11px}",
  );
  const body = repeat(250, (i) =>
    el(
      "tr",
      "",
      el("td", "", String(i + 1), { class: "n" }) +
        el("td", "", r.words(2)) +
        el("td", "", r.pick(["Free", "Team", "Business", "Enterprise"])) +
        el("td", "", String(r.int(1, 400)), { class: "n" }) +
        el("td", "", `$${r.int(0, 99)},${r.int(100, 999)}.00`, { class: "n" }) +
        el(
          "td",
          "",
          el("span", `background:${r.pick(PALETTE.slice(9, 14))}`, r.pick(status), { class: "b" }),
        ) +
        el("td", "", r.pick(["us-east", "us-west", "eu-west", "ap-south"])) +
        el("td", "", r.words(1)) +
        el(
          "td",
          "",
          `2027-${String(r.int(1, 12)).padStart(2, "0")}-${String(r.int(1, 28)).padStart(2, "0")}`,
        ) +
        el(
          "td",
          "",
          el(
            "i",
            `display:inline-block;width:${r.int(4, 60)}px;height:6px;border-radius:3px;background:${r.pick(PALETTE.slice(0, 7))}`,
          ),
        ),
    ),
  );
  return board(
    spec,
    `width:1440px;height:6800px;overflow:hidden;background:#fff;color:var(--bench-ink);${FONT};padding:24px`,
    sheet +
      el(
        "table",
        "",
        el("thead", "", el("tr", "", heads.map((h) => el("th", "", h)).join(""))) +
          el("tbody", "", body),
      ),
  );
}

/* ------------------------------------------------------------------ */
/* text-wall                                                           */
/* ------------------------------------------------------------------ */

function textWall(spec: BoardSpec): Artboard {
  const r = rng("text-wall");
  const inline = () => {
    switch (r.int(0, 6)) {
      case 0:
        return el("em", "", r.words(r.int(1, 4)));
      case 1:
        return el("strong", "", r.words(r.int(1, 3)));
      case 2:
        return el("a", "color:var(--bench-accent-2)", r.words(r.int(1, 4)), { href: "#" });
      case 3:
        return el(
          "code",
          "font-family:var(--bench-mono);font-size:0.85em;background:#F1EFEA;padding:1px 4px;border-radius:3px",
          r.words(1),
        );
      case 4:
        return el(
          "span",
          "font-family:var(--bench-font);font-variant:small-caps;letter-spacing:0.04em",
          r.words(r.int(1, 3)),
        );
      case 5:
        return el("mark", "background:#FBEFC6", r.words(r.int(2, 5)));
      default:
        return el("span", "font-family:cursive;color:#A646D6", r.words(r.int(1, 2)));
    }
  };
  const paragraph = () => {
    let p = "";
    const parts = r.int(4, 8);
    for (let i = 0; i < parts; i++) p += `${r.sentence(6, 16)} ${inline()} `;
    return el("p", "margin:0 0 1em;text-align:justify;hyphens:auto", p.trim());
  };
  let article = el(
    "h1",
    `margin:0 0 24px;font-family:var(--bench-font);font-size:56px;line-height:1.05;column-span:all`,
    r.sentence(6, 9),
  );
  for (let s = 0; s < 11; s++) {
    article += el(
      "h2",
      "margin:1.2em 0 0.4em;font-family:var(--bench-font);font-size:24px",
      r.sentence(3, 6),
    );
    article += repeat(r.int(5, 8), paragraph);
    if (s % 3 === 1)
      article += el(
        "blockquote",
        "margin:1em 0;padding-left:16px;border-left:3px solid var(--bench-accent);font-style:italic;font-size:1.15em",
        r.sentence(14, 24),
      );
    if (s % 4 === 2)
      article += el(
        "ul",
        "margin:0 0 1em;padding-left:1.2em",
        repeat(5, () => el("li", "", `${r.sentence(5, 10)} ${inline()}`)),
      );
  }
  return board(
    spec,
    `width:1440px;height:6400px;overflow:hidden;background:#FFFDF8;color:var(--bench-ink);font-family:var(--bench-serif);font-size:17px;line-height:1.6;padding:80px`,
    // The article is as tall as the board and fills its columns in order, so the text fits the
    // board's height exactly; what doesn't fit runs into a fourth column, clipped.
    el(
      "article",
      "height:6240px;column-count:3;column-fill:auto;column-gap:56px;column-rule:1px solid var(--bench-line)",
      article,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* effects: heavy paint                                                */
/* ------------------------------------------------------------------ */

function effects(spec: BoardSpec): Artboard {
  const r = rng("effects");
  const background = el(
    "div",
    "position:absolute;inset:0;background:radial-gradient(circle at 20% 20%,#FF5A1F88,transparent 40%),radial-gradient(circle at 80% 30%,#3D5BFF99,transparent 45%),conic-gradient(from 45deg at 50% 60%,#0FA38A,#F0AE00,#A646D6,#E0382B,#0FA38A),linear-gradient(180deg,#15140F,#2E2D28)",
  );
  const blobs = repeat(14, () =>
    el(
      "div",
      `position:absolute;left:${r.int(-100, 1300)}px;top:${r.int(-100, 1700)}px;width:${r.int(200, 500)}px;height:${r.int(200, 500)}px;border-radius:50%;background:${r.pick(PALETTE)};filter:blur(${r.int(30, 90)}px);opacity:.7;mix-blend-mode:${r.pick(["screen", "multiply", "overlay", "color-dodge", "difference"])}`,
    ),
  );
  const shapes = [
    "circle(50%)",
    "polygon(50% 0,100% 50%,50% 100%,0 50%)",
    "polygon(0 0,100% 0,80% 100%,20% 100%)",
    "inset(10% round 24px)",
    "ellipse(40% 50%)",
  ];
  const cards = repeat(48, (i) =>
    el(
      "div",
      `position:relative;height:200px;padding:20px;border-radius:${r.int(8, 40)}px;color:#fff;background:rgba(255,255,255,.12);backdrop-filter:blur(${r.int(8, 30)}px) saturate(1.6);border:1px solid rgba(255,255,255,.25);box-shadow:0 1px 0 rgba(255,255,255,.3) inset,0 ${r.int(8, 40)}px ${r.int(20, 80)}px rgba(0,0,0,.4),0 0 0 ${r.int(1, 4)}px ${r.pick(PALETTE)}55;overflow:hidden`,
      el(
        "div",
        `position:absolute;right:-30px;top:-30px;width:140px;height:140px;background:linear-gradient(${r.int(0, 360)}deg,${r.pick(PALETTE)},${r.pick(PALETTE)});clip-path:${shapes[i % shapes.length]};filter:drop-shadow(0 8px 12px rgba(0,0,0,.5))`,
      ) +
        el(
          "div",
          `position:absolute;inset:0;background:repeating-linear-gradient(${r.int(0, 180)}deg,rgba(255,255,255,.08) 0 2px,transparent 2px 8px);mask-image:linear-gradient(to bottom,#000,transparent);-webkit-mask-image:linear-gradient(to bottom,#000,transparent)`,
        ) +
        el(
          "div",
          "position:relative;font-size:22px;font-weight:700;text-shadow:0 2px 8px rgba(0,0,0,.5)",
          r.words(2),
        ) +
        el(
          "div",
          "position:relative;margin-top:8px;font-size:13px;opacity:.85;filter:contrast(1.2) brightness(1.1)",
          r.sentence(8, 14),
        ) +
        el(
          "svg",
          `position:absolute;left:20px;bottom:16px;filter:drop-shadow(0 4px 6px ${r.pick(PALETTE)})`,
          el("circle", "", "", { cx: 20, cy: 20, r: 16, fill: r.pick(PALETTE) }) +
            el("rect", "", "", {
              x: 44,
              y: 6,
              width: 60,
              height: 28,
              rx: 14,
              fill: "rgba(255,255,255,.6)",
            }),
          { width: 120, height: 40 },
        ),
    ),
  );
  return board(
    spec,
    `width:1440px;height:2000px;overflow:hidden;background:#15140F;${FONT}`,
    background +
      blobs +
      el(
        "div",
        "position:absolute;inset:60px;display:grid;grid-template-columns:repeat(6,1fr);gap:24px;align-content:start;isolation:isolate",
        cards,
      ) +
      el(
        "div",
        "position:absolute;left:0;right:0;bottom:0;height:400px;background:linear-gradient(transparent,#000);mix-blend-mode:multiply;pointer-events:none",
      ),
  );
}

/* ------------------------------------------------------------------ */
/* animated                                                            */
/* ------------------------------------------------------------------ */

function animated(spec: BoardSpec): Artboard {
  const r = rng("animated");
  // A board's `<style>` is its own (it draws in a shadow root), so its keyframes are too.
  const sheet = el(
    "style",
    "",
    "@keyframes spin{to{transform:rotate(360deg)}}" +
      "@keyframes pulse{0%,100%{opacity:.25;transform:scale(.6)}50%{opacity:1;transform:scale(1)}}" +
      "@keyframes marquee{from{transform:translateX(0)}to{transform:translateX(-50%)}}" +
      "@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}" +
      "@keyframes shimmer{from{background-position:-400px 0}to{background-position:400px 0}}" +
      "@keyframes hue{to{filter:hue-rotate(360deg)}}" +
      ".sp{width:20px;height:20px;border-radius:50%;border:3px solid #E2DED3;border-top-color:#FF5A1F;animation:spin 1s linear infinite}" +
      ".pu{width:12px;height:12px;border-radius:50%;animation:pulse 1.4s ease-in-out infinite}" +
      ".fl{animation:float 3s ease-in-out infinite}" +
      ".sh{height:12px;border-radius:6px;background:linear-gradient(90deg,#ECE9E1 0,#F7F5F0 50%,#ECE9E1 100%);background-size:800px 100%;animation:shimmer 1.6s linear infinite}" +
      ".mq{display:flex;gap:24px;width:max-content;animation:marquee 20s linear infinite}" +
      ".hu{animation:hue 6s linear infinite}",
  );
  const delay = () => `animation-delay:-${(r.next() * 2).toFixed(2)}s`;
  const spinners = el(
    "div",
    "display:grid;grid-template-columns:repeat(30,1fr);gap:12px;padding:24px",
    repeat(240, () =>
      el("div", `${delay()};animation-duration:${(0.6 + r.next()).toFixed(2)}s`, "", {
        class: "sp",
      }),
    ),
  );
  const pulses = el(
    "div",
    "display:grid;grid-template-columns:repeat(40,1fr);gap:10px;padding:24px",
    repeat(240, () => el("div", `${delay()};background:${r.pick(PALETTE)}`, "", { class: "pu" })),
  );
  const marquee = el(
    "div",
    "overflow:hidden;padding:16px 0;background:#15140F;color:#fff;font-size:20px;font-weight:700",
    el(
      "div",
      "",
      repeat(60, (i) => el("span", "white-space:nowrap", `${r.words(2)} ${i % 2 ? "✦" : "•"}`)),
      { class: "mq" },
    ),
  );
  const floats = el(
    "div",
    "display:grid;grid-template-columns:repeat(8,1fr);gap:16px;padding:24px",
    repeat(40, () =>
      el(
        "div",
        `${delay()};padding:12px;border-radius:10px;background:#fff;box-shadow:var(--bench-shadow)`,
        el("div", "width:60%;margin-bottom:8px", "", { class: "sh" }) +
          el("div", "width:90%", "", { class: "sh" }),
        { class: "fl" },
      ),
    ),
  );
  const svgs = el(
    "div",
    "display:flex;flex-wrap:wrap;gap:16px;padding:24px",
    repeat(32, (i) =>
      el(
        "svg",
        "",
        el(
          "g",
          "",
          el("circle", "", "", {
            cx: 24,
            cy: 24,
            r: 18,
            fill: "none",
            stroke: r.pick(PALETTE),
            "stroke-width": 4,
            "stroke-dasharray": "60 40",
          }) +
            el("animateTransform", "", "", {
              attributeName: "transform",
              type: "rotate",
              from: "0 24 24",
              to: "360 24 24",
              dur: `${(0.8 + r.next()).toFixed(2)}s`,
              repeatCount: "indefinite",
            }),
        ) +
          el(
            "circle",
            "",
            el("animate", "", "", {
              attributeName: "r",
              values: "2;8;2",
              dur: `${(1 + r.next()).toFixed(2)}s`,
              repeatCount: "indefinite",
            }),
            { cx: 24, cy: 24, r: 4, fill: r.pick(PALETTE) },
          ),
        { width: 48, height: 48, viewBox: "0 0 48 48", ...(i % 3 === 0 ? { class: "hu" } : {}) },
      ),
    ),
  );
  return board(
    spec,
    `width:1440px;height:1400px;overflow:hidden;background:var(--bench-paper);${FONT}`,
    sheet + marquee + spinners + pulses + floats + svgs,
  );
}

/* ------------------------------------------------------------------ */
/* svg-chart                                                           */
/* ------------------------------------------------------------------ */

function svgChart(spec: BoardSpec): Artboard {
  const r = rng("svg-chart");
  // Whole pixels: a decimal on each of ~20,000 coordinates is ~40 KB of op for nothing seen.
  const f = (n: number) => String(Math.round(n));
  // Scatter: circles grouped by colour, so each carries only its place.
  const scatter = repeat(6, (g) =>
    el(
      "g",
      "",
      repeat(300, () => {
        const x = r.next();
        const y = Math.min(1, Math.max(0, x * (0.3 + g * 0.12) + (r.next() - 0.5) * 0.4));
        return el("circle", "", "", { cx: f(40 + x * 700), cy: f(560 - y * 520), r: 3 });
      }),
      { fill: PALETTE[g]!, "fill-opacity": 0.6 },
    ),
  );
  // Stacked bars.
  const bars = repeat(3, (s) =>
    el(
      "g",
      "",
      repeat(120, (i) => {
        const h = 20 + 60 * Math.abs(Math.sin(i / 9 + s));
        return el("rect", "", "", {
          x: f(820 + i * 6),
          y: f(560 - (s + 1) * 80 - h * 0.3),
          width: 5,
          height: f(h),
        });
      }),
      { fill: PALETTE[s + 1]! },
    ),
  );
  // Lines: long paths.
  const lines = repeat(40, (l) => {
    let d = "";
    let y = 300 + r.int(-120, 120);
    for (let i = 0; i <= 200; i++) {
      y = Math.min(580, Math.max(20, y + (r.next() - 0.5) * 14));
      d += `${i ? "L" : "M"}${f(40 + i * 3.5)} ${f(620 + y)}`;
    }
    return el("path", "", "", {
      d,
      stroke: PALETTE[l % 16]!,
      fill: "none",
      "stroke-width": 1,
      "stroke-opacity": 0.7,
    });
  });
  // A hex map, like a choropleth: a path per hex, grouped into ten fill classes.
  const buckets: string[] = Array.from({ length: 10 }, () => "");
  for (let k = 0; k < 2000; k++) {
    const col = k % 50;
    const row = Math.floor(k / 50);
    const v = (Math.sin(col / 6) + Math.cos(row / 5) + 2) / 4;
    const d = `M${820 + col * 15 + (row % 2) * 8} ${632 + row * 13}l7 4v8l-7 4l-7-4v-8z`;
    buckets[Math.min(9, Math.floor(v * 10))] += el("path", "", "", { d });
  }
  const hexes = buckets
    .map((paths, b) => el("g", "", paths, { fill: `hsl(${200 + b * 14} 70% ${35 + b * 4}%)` }))
    .join("");
  const ticks = repeat(4, (p) =>
    el(
      "g",
      "",
      repeat(
        30,
        (i) =>
          el("line", "", "", {
            x1: (p % 2) * 780 + 40 + i * 24,
            y1: 580 + Math.floor(p / 2) * 600,
            x2: (p % 2) * 780 + 40 + i * 24,
            y2: 586 + Math.floor(p / 2) * 600,
          }) +
          el("text", "", String(i * 10), {
            x: (p % 2) * 780 + 40 + i * 24,
            y: 598 + Math.floor(p / 2) * 600,
            "font-size": 8,
            "text-anchor": "middle",
            stroke: "none",
          }),
      ),
      { stroke: "#8C887D", fill: "#55524A" },
    ),
  );
  const svg = el("svg", "display:block", scatter + bars + lines + hexes + ticks, {
    width: 1600,
    height: 1240,
    viewBox: "0 0 1600 1240",
    "font-family": "system-ui",
  });
  return board(spec, "width:1600px;height:1240px;background:#fff", svg);
}

/* ------------------------------------------------------------------ */
/* images                                                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An RGB PNG as a data URI, from a function of each pixel: no network, no image library. */
function png(
  w: number,
  h: number,
  pixel: (x: number, y: number) => [number, number, number],
): string {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), row + 1 + x * 3);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ];
  return `data:image/png;base64,${Buffer.concat(parts).toString("base64")}`;
}

function svgUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function images(spec: BoardSpec): Artboard {
  const r = rng("images");
  const svgArt = (i: number) => {
    const a = PALETTE[i % 7]!;
    const b = PALETTE[(i + 3) % 7]!;
    const w = r.pick([64, 200, 640, 1200]);
    const h = Math.round(w * r.pick([0.5, 0.75, 1, 1.5]));
    const hills = repeat(4, (k) => {
      let d = `M0 ${h}`;
      for (let x = 0; x <= 10; x++)
        d += ` L${(w * x) / 10} ${Math.round(h * (0.45 + k * 0.1) + Math.sin(x + k + i) * h * 0.08)}`;
      return `<path d="${d} L${w} ${h}Z" fill="${PALETTE[(i + k) % 16]}" fill-opacity="0.8"/>`;
    });
    return svgUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.12}" fill="#FBEFC6"/>${hills}</svg>`,
    );
  };
  const pngs = [
    png(8, 8, (x, y) => ((x + y) % 2 ? [255, 90, 31] : [21, 20, 15])),
    png(16, 16, (x, y) => [x * 16, y * 16, 128]),
    png(32, 32, (x, y) => (Math.hypot(x - 16, y - 16) < 12 ? [61, 91, 255] : [244, 242, 236])),
    png(64, 48, (x, y) => [
      Math.round(127 + 127 * Math.sin(x / 5)),
      Math.round(127 + 127 * Math.cos(y / 4)),
      160,
    ]),
    png(128, 96, (x, y) => [x * 2, 255 - y * 2, 128]),
    // Posterised, so it compresses to a few kilobytes and the board stays small.
    png(256, 160, (x, y) => {
      const v = Math.round((Math.sin(x / 13) + Math.sin(y / 9) + Math.sin((x + y) / 17)) * 3) / 3;
      return [Math.round(127 + 42 * v), Math.round(90 + 30 * v), Math.round(200 - 40 * v)];
    }),
    png(48, 48, () => [r.int(0, 255), r.int(0, 255), r.int(0, 255)]),
    png(400, 8, (x) => [x % 256, 120, 255 - (x % 256)]),
  ];
  const svgs = Array.from({ length: 12 }, (_, i) => svgArt(i));
  const sources = [...pngs, ...svgs];
  const fits = ["cover", "contain", "fill", "none", "scale-down"];
  const imgs = repeat(40, (i) => {
    const w = r.pick([40, 80, 120, 200, 320, 480]);
    const h = r.pick([40, 80, 120, 200, 300]);
    const src = sources[i % sources.length]!;
    return el(
      "figure",
      "margin:0;display:flex;flex-direction:column;gap:4px",
      `<img src="${src}" alt="" width="${w}" height="${h}" style="width:${w}px;height:${h}px;object-fit:${fits[i % fits.length]};object-position:${r.pick(["center", "top left", "70% 30%"])};border-radius:${r.pick([0, 6, 16, 999])}px;background:#ECE9E1${i < 8 ? ";image-rendering:pixelated" : ""}">` +
        el(
          "figcaption",
          "font-size:11px;color:var(--bench-ink-3)",
          `${w}×${h} ${fits[i % fits.length]}`,
        ),
    );
  });
  const backgrounds = repeat(10, (i) =>
    el(
      "div",
      `width:260px;height:180px;border-radius:12px;background-image:${i % 3 === 0 ? `linear-gradient(rgba(0,0,0,.2),rgba(0,0,0,.6)),` : ""}url(${sources[(i * 3) % sources.length]});background-size:${r.pick(["cover", "contain", "48px 48px", "auto"])};background-repeat:${r.pick(["no-repeat", "repeat", "repeat-x", "space"])};background-position:center;background-color:#15140F`,
    ),
  );
  return board(
    spec,
    `width:1440px;height:2600px;overflow:hidden;background:var(--bench-paper);${FONT};padding:40px`,
    el("div", "display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start", imgs) +
      el("div", "display:flex;flex-wrap:wrap;gap:24px;margin-top:40px", backgrounds),
  );
}

/* ------------------------------------------------------------------ */
/* fit-content                                                         */
/* ------------------------------------------------------------------ */

function fitContent(spec: BoardSpec): Artboard {
  const r = rng("fit-content");
  const sections = repeat(16, () =>
    el(
      "section",
      "padding:48px 64px;border-bottom:1px solid var(--bench-line)",
      el("h2", "margin:0 0 16px;font-size:32px", r.sentence(3, 6)) +
        repeat(3, () =>
          el(
            "p",
            "margin:0 0 12px;font-size:16px;line-height:1.6;color:var(--bench-ink-2)",
            r.sentence(20, 50),
          ),
        ) +
        el(
          "div",
          "display:flex;flex-wrap:wrap;gap:16px;margin-top:24px",
          repeat(r.int(6, 14), () =>
            el(
              "div",
              `flex:1 1 ${r.int(160, 320)}px;padding:16px;border-radius:var(--bench-radius);background:var(--bench-card);box-shadow:var(--bench-shadow)`,
              el(
                "div",
                `height:${r.int(40, 140)}px;border-radius:6px;margin-bottom:12px;background:linear-gradient(${r.int(0, 360)}deg,${r.pick(PALETTE)},${r.pick(PALETTE)})`,
              ) +
                el("h3", "margin:0 0 6px;font-size:16px", r.sentence(2, 5)) +
                el(
                  "p",
                  "margin:0;font-size:14px;line-height:1.5;color:var(--bench-ink-2)",
                  r.sentence(8, 30),
                ),
            ),
          ),
        ) +
        el(
          "ul",
          "margin:24px 0 0;columns:3;font-size:14px",
          repeat(r.int(6, 15), () => el("li", "margin-bottom:6px", r.sentence(3, 9))),
        ),
    ),
  );
  return board(
    spec,
    `width:1200px;height:fit-content;background:var(--bench-paper);color:var(--bench-ink);${FONT}`,
    sections,
  );
}

/* ------------------------------------------------------------------ */
/* huge: one 8000×8000 board, mostly empty                             */
/* ------------------------------------------------------------------ */

function huge(spec: BoardSpec): Artboard {
  const r = rng("huge");
  const clusters = repeat(80, () =>
    el(
      "div",
      `position:absolute;left:${r.int(0, 7700)}px;top:${r.int(0, 7750)}px;width:${r.int(160, 300)}px;padding:12px;border-radius:12px;background:#fff;box-shadow:var(--bench-shadow)`,
      el(
        "div",
        `height:${r.int(30, 90)}px;border-radius:8px;margin-bottom:8px;background:${r.pick(PALETTE)}`,
      ) +
        el("div", "font-weight:700;font-size:14px", r.sentence(2, 4)) +
        el("div", "font-size:12px;color:var(--bench-ink-2)", r.sentence(6, 12)) +
        el(
          "div",
          "display:flex;gap:4px;margin-top:8px",
          repeat(3, () =>
            el("i", `width:16px;height:16px;border-radius:50%;background:${r.pick(PALETTE)}`),
          ),
        ),
    ),
  );
  const labels = repeat(16, (i) =>
    el(
      "div",
      `position:absolute;left:${(i % 4) * 2000 + 40}px;top:${Math.floor(i / 4) * 2000 + 40}px;font-size:96px;font-weight:900;color:#0000000F`,
      `${String.fromCharCode(65 + (i % 4))}${Math.floor(i / 4) + 1}`,
    ),
  );
  return board(
    spec,
    `width:8000px;height:8000px;background-color:#F7F5F0;background-image:linear-gradient(#E2DED3 1px,transparent 1px),linear-gradient(90deg,#E2DED3 1px,transparent 1px);background-size:100px 100px;${FONT}`,
    labels + clusters,
  );
}

/* ------------------------------------------------------------------ */
/* tiny-card                                                           */
/* ------------------------------------------------------------------ */

function tinyCard(spec: BoardSpec): Artboard {
  const r = rng("tiny-card");
  return board(
    spec,
    `width:360px;height:240px;background:var(--bench-card);color:var(--bench-ink);${FONT};border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:12px`,
    el(
      "div",
      "display:flex;align-items:center;gap:12px",
      el(
        "i",
        "width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#FF5A1F,#A646D6)",
      ) +
        el(
          "div",
          "",
          el("div", "font-weight:700;font-size:16px", r.words(2)) +
            el("div", "font-size:13px;color:var(--bench-ink-3)", r.words(3)),
        ),
    ) +
      el(
        "p",
        "margin:0;font-size:14px;line-height:1.45;color:var(--bench-ink-2)",
        r.sentence(14, 18),
      ) +
      el(
        "div",
        "display:flex;gap:6px",
        repeat(3, (i) =>
          el(
            "span",
            `padding:2px 8px;border-radius:999px;font-size:12px;background:${PALETTE[9 + i]}`,
            r.words(1),
          ),
        ),
      ) +
      el("div", "flex:1") +
      el(
        "div",
        "align-self:flex-end;padding:8px 14px;border-radius:8px;background:var(--bench-ink);color:#fff;font-size:13px;font-weight:600",
        "Open",
      ),
  );
}

/* ------------------------------------------------------------------ */
/* The corpus                                                          */
/* ------------------------------------------------------------------ */

export const BOARDS: Record<BoardKind, { covers: string; make(spec: BoardSpec): Artboard }> = {
  "landing-weft": {
    covers: "A real example landing page (Weft): tall, token-styled marketing DOM with inline SVG.",
    make: landing("landing-weft"),
  },
  "landing-kettle": {
    covers: "A real example landing page (Kettle) with phone mockups and token-styled sections.",
    make: landing("landing-kettle"),
  },
  "landing-halon": {
    covers: "A real example landing page (Halon) with gradients, SVG defs and dense product shots.",
    make: landing("landing-halon"),
  },
  site: {
    covers:
      "A tall marketing site whose dozen miniature app windows and huge footer make thousands of tiny nodes to rasterize when zooming.",
    make: site,
  },
  "dense-grid": {
    covers: "Eight thousand tiny absolutely positioned boxes, stressing layer and paint counts.",
    make: denseGrid,
  },
  "deep-tree": {
    covers:
      "Flex containers nested as deep as one op allows, stressing recursive layout and style resolution.",
    make: deepTree,
  },
  table: {
    covers: "A 250-row, 10-column HTML table, stressing table layout.",
    make: table,
  },
  "text-wall": {
    covers:
      "A long three-column article with mixed fonts and inline markup, stressing text shaping and line breaking.",
    make: textWall,
  },
  effects: {
    covers:
      "Blur, backdrop-filter, blend modes, clip paths, masks and layered shadows over large gradients, stressing paint and compositing.",
    make: effects,
  },
  animated: {
    covers: "Hundreds of running CSS and SVG animations, so the board never stops repainting.",
    make: animated,
  },
  "svg-chart": {
    covers: "One inline SVG with about five thousand circles, rects and paths.",
    make: svgChart,
  },
  images: {
    covers:
      "Forty data-URI images of varied sizes and object-fit, plus CSS background images, stressing image decode and scaling.",
    make: images,
  },
  "fit-content": {
    covers:
      "A board whose height is fit-content, so the canvas must measure its flowing content before framing it.",
    make: fitContent,
  },
  huge: {
    covers: "One 8000×8000 board with sparse content, stressing very large layers and tiling.",
    make: huge,
  },
  "tiny-card": {
    covers: "A small 360×240 card, meant to be repeated many times on one canvas.",
    make: tinyCard,
  },
};
