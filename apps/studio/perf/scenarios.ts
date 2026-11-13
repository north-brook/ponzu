/*
 * What the harness plays, surface by surface. A suite sets up one state (a canvas seeded and
 * opened, a long thread) and its scenarios run in order on it, each measured on its own: Chrome
 * traced, the frame clock read, React's commits counted.
 *
 * Gestures are a fixed number of frames (probe.ts), so the counts they yield are the same on any
 * machine. One-off actions (a commit landing, a canvas switched to) are timed in the page, from
 * the action to the frame that shows its result.
 */
import type { Artboard } from "@ponzu/core";
import {
  boardsReady,
  domNodes,
  linkTo,
  type Seed,
  type Studio,
  seedCanvas,
  settled,
  zoomPercent,
} from "./app.ts";
import { BOARDS, type BoardKind, CORPUS_TOKENS } from "./corpus.ts";
import { frameStats, percentile, round } from "./metrics.ts";
import { summarize, traced } from "./trace.ts";

export type Surface = "canvas" | "panes" | "thread" | "sidebar" | "sandbox";
export type Measured = Record<string, number>;

export interface Scenario {
  /** `<suite>.<name>`, stable across runs: history is kept by it. */
  id: string;
  title: string;
  /** The metrics the comment's summary shows for it. */
  headline: string[];
  run(s: Studio, state: SuiteState): Promise<Measured>;
}

export interface SuiteState {
  canvasId: string;
  [key: string]: unknown;
}

export interface Suite {
  id: string;
  surface: Surface;
  /** What it stands for, for the report's key. */
  about: string;
  setup(s: Studio): Promise<SuiteState>;
  scenarios: Scenario[];
}

/* ------------------------------------------------------------------ */
/* Canvases                                                            */
/* ------------------------------------------------------------------ */

const GAP = 100;

/** Boards of `kinds` in a row, `GAP` apart, ids prefixed by the canvas. */
function row(prefix: string, kinds: BoardKind[], y = 0): Artboard[] {
  let x = 0;
  return kinds.map((kind, i) => {
    const ab = BOARDS[kind].make({ id: `ab_${prefix}${i}`, name: kind, x, y });
    x += Number.parseFloat(String(ab.root.style.width)) + GAP || 1540;
    return ab;
  });
}

/** `n` copies of a kind on a grid of `cols` columns. */
function grid(prefix: string, kind: BoardKind, n: number, cols: number): Artboard[] {
  const out: Artboard[] = [];
  let w = 0;
  let h = 0;
  for (let i = 0; i < n; i++) {
    const ab = BOARDS[kind].make({ id: `ab_${prefix}${i}`, name: `${kind} ${i + 1}`, x: 0, y: 0 });
    w ||= Number.parseFloat(String(ab.root.style.width)) || 360;
    h ||= Number.parseFloat(String(ab.root.style.height)) || 240;
    ab.x = (i % cols) * (w + GAP / 2);
    ab.y = Math.floor(i / cols) * (h + GAP / 2);
    out.push(ab);
  }
  return out;
}

export const CANVASES: Record<string, { about: string; seed: () => Seed }> = {
  website: {
    about:
      "Two tall marketing pages dense with mockups and a big footer, side by side: the canvas that was slow to zoom.",
    seed: () => ({ name: "Website", tokens: CORPUS_TOKENS, boards: row("ws", ["site", "site"]) }),
  },
  examples: {
    about: "The example designs' three landing pages, as an agent draws them.",
    seed: () => ({
      name: "Examples",
      tokens: CORPUS_TOKENS,
      boards: row("ex", ["landing-weft", "landing-kettle", "landing-halon"]),
    }),
  },
  dom: {
    about:
      "Heavy DOM: a dense grid, a big table, a 300-deep tree, a wall of text and a fit-content page.",
    seed: () => ({
      name: "DOM",
      tokens: CORPUS_TOKENS,
      boards: row("dm", ["dense-grid", "table", "deep-tree", "text-wall", "fit-content"]),
    }),
  },
  paint: {
    about: "Heavy paint: shadows, filters, blends and masks, big SVG charts and many images.",
    seed: () => ({
      name: "Paint",
      tokens: CORPUS_TOKENS,
      boards: row("pt", ["effects", "svg-chart", "images"]),
    }),
  },
  motion: {
    about: "Hundreds of running CSS and SVG animations.",
    seed: () => ({ name: "Motion", tokens: CORPUS_TOKENS, boards: row("mo", ["animated"]) }),
  },
  many: {
    about: "Sixty small boards on one page.",
    seed: () => ({ name: "Many", tokens: CORPUS_TOKENS, boards: grid("mn", "tiny-card", 60, 10) }),
  },
  huge: {
    about: "One 8000 px square board, sparse.",
    seed: () => ({ name: "Huge", tokens: CORPUS_TOKENS, boards: row("hg", ["huge"]) }),
  },
};

/* ------------------------------------------------------------------ */
/* Measuring                                                           */
/* ------------------------------------------------------------------ */

/** How long the canvas rests after a gesture: past its 150 ms settle, and the redraw after. */
const REST_MS = 700;

/**
 * Plays `play` (in the page) and the rest after it, traced. The frame numbers are the gesture's;
 * `settleMs` is the worst frame of the rest.
 */
async function gesture(s: Studio, play: () => Promise<unknown>): Promise<Measured> {
  const { page, cdp } = s;
  const { value, events } = await traced(cdp, async () => {
    const t0 = await page.evaluate(() => window.__pz.now());
    const commits0 = await page.evaluate(() => window.__pz.commits);
    await play();
    const t1 = await page.evaluate(() => window.__pz.now());
    await page.evaluate(async (ms) => {
      const end = window.__pz.now() + ms;
      while (window.__pz.now() < end) await window.__pz.frame();
    }, REST_MS);
    const t2 = await page.evaluate(() => window.__pz.now());
    const r = await page.evaluate(() => ({
      frames: window.__pz.frames,
      commits: window.__pz.commits,
    }));
    return {
      during: frameStats(r.frames, t0, t1),
      after: frameStats(r.frames, t1, t2),
      commits: r.commits - commits0,
    };
  });
  const t = summarize(events);
  const frames = Math.max(1, value.during.frames);
  return {
    fps: value.during.fps,
    frameP95: value.during.frameP95,
    longFrames: value.during.longFrames,
    settleMs: value.after.maxFrame,
    mainMs: round(t.mainMs),
    scriptMs: round(t.scriptMs),
    styleMs: round(t.styleMs),
    layoutMs: round(t.layoutMs),
    paintMs: round(t.paintMs),
    rasterMs: round(t.rasterMs),
    gpuMs: round(t.gpuMs),
    longestTaskMs: round(t.longestTaskMs, 1),
    restyledPerFrame: round(t.restyled / frames),
    laidOutPerFrame: round(t.laidOut / frames),
    commits: value.commits,
  };
}

/**
 * Times `act` in the page: `act` returns once its result is on the page, and the latency runs
 * to the frame after. Traced, for what it cost.
 */
async function action(s: Studio, act: () => Promise<unknown>): Promise<Measured> {
  const { page, cdp } = s;
  const { value, events } = await traced(cdp, async () => {
    const commits0 = await page.evaluate(() => window.__pz.commits);
    const t0 = await page.evaluate(() => window.__pz.now());
    await act();
    const t1 = await page.evaluate(async () => window.__pz.frame());
    await settled(page);
    const commits = (await page.evaluate(() => window.__pz.commits)) - commits0;
    return { latencyMs: t1 - t0, commits };
  });
  const t = summarize(events);
  return {
    latencyMs: round(value.latencyMs, 1),
    mainMs: round(t.mainMs),
    scriptMs: round(t.scriptMs),
    styleMs: round(t.styleMs),
    layoutMs: round(t.layoutMs),
    longestTaskMs: round(t.longestTaskMs, 1),
    restyled: t.restyled,
    laidOut: t.laidOut,
    commits: value.commits,
  };
}

/* ------------------------------------------------------------------ */
/* Canvas suites                                                       */
/* ------------------------------------------------------------------ */

/** Pinch in for 60 frames and back out for 60: about 6× in and out again. */
const pinch = (s: Studio) =>
  gesture(s, () =>
    s.page.evaluate(async () => {
      await window.__pz.wheel(60, -1.5, true);
      await window.__pz.wheel(60, 1.5, true);
    }),
  );

/** Scroll down for 45 frames and back up for 45. */
const pan = (s: Studio) =>
  gesture(s, () =>
    s.page.evaluate(async () => {
      await window.__pz.wheel(45, 12, false);
      await window.__pz.wheel(45, -12, false);
    }),
  );

/** Opens the canvas seeded from `canvas`, timed from the link to every board drawn. */
async function openCanvas(s: Studio, canvas: string): Promise<{ state: SuiteState; m: Measured }> {
  const canvasId = await seedCanvas(s.page, CANVASES[canvas]!.seed());
  await settled(s.page);
  const m = await action(s, async () => {
    await linkTo(s.page, canvasId);
    await boardsReady(s.page);
  });
  m.domNodes = await domNodes(s.page);
  return { state: { canvasId, open: m }, m };
}

function canvasSuite(canvas: string, extra: Scenario[] = [], gestures = true): Suite {
  return {
    id: canvas,
    surface: "canvas",
    about: CANVASES[canvas]!.about,
    setup: async (s) => (await openCanvas(s, canvas)).state,
    scenarios: [
      {
        id: `${canvas}.open`,
        title: "Open",
        headline: ["latencyMs", "longestTaskMs", "domNodes"],
        run: async (_s, state) => state.open as Measured,
      },
      ...(gestures
        ? [
            {
              id: `${canvas}.zoom`,
              title: "Pinch zoom",
              headline: ["fps", "mainMs", "restyledPerFrame"],
              run: (s: Studio) => pinch(s),
            },
            {
              id: `${canvas}.pan`,
              title: "Pan",
              headline: ["fps", "mainMs", "restyledPerFrame"],
              run: (s: Studio) => pan(s),
            },
          ]
        : []),
      ...extra,
    ],
  };
}

/** Drags a pane's edge to and fro for 60 frames. */
function resize(pane: "sidebar" | "thread"): Scenario {
  return {
    id: `website.resize-${pane}`,
    title: `Resize the ${pane}`,
    headline: ["fps", "mainMs", "restyledPerFrame"],
    run: async (s) => {
      const selector = `#${pane}-pane-edge`;
      if (!(await s.page.locator(selector).count())) throw new Error(`No ${selector}.`);
      const m = await gesture(s, () =>
        s.page.evaluate((sel) => window.__pz.drag(sel, 60, 120), selector),
      );
      return m;
    },
  };
}

/** The agent changes one line of text in the first board; timed until it shows. */
const commitText: Scenario = {
  id: "website.commit",
  title: "Agent edits a line",
  headline: ["latencyMs", "restyled", "commits"],
  run: (s, state) =>
    action(s, () =>
      s.page.evaluate(async (canvasId) => {
        const w = window.ponzuFake!;
        const doc = w.backend.canvas(canvasId).sequencer.doc;
        const board = doc.pages[0]!.artboards[0]!;
        // The first element holding text directly: its text is replaced.
        const find = (n: any): any =>
          n.kind === "el" && n.children.some((c: any) => c.kind === "text")
            ? n
            : n.kind === "el"
              ? n.children.map(find).find(Boolean)
              : null;
        const el = find(board.root);
        const word = `Edited ${Math.random().toString(36).slice(2, 8)}`;
        w.backend
          .agent(canvasId)
          .commit([{ op: "children", id: el.id, children: [{ kind: "text", value: word }] }]);
        const host = document.querySelector(`[data-pz-board="${board.id}"]`);
        const shows = () => {
          const walk = (root: ParentNode): boolean => {
            for (const e of root.querySelectorAll("*")) {
              if (e.shadowRoot && walk(e.shadowRoot)) return true;
            }
            return (root as Element).textContent?.includes(word) ?? false;
          };
          return !!host && walk(host);
        };
        while (!shows()) await window.__pz.frame();
      }, state.canvasId),
    ),
};

/** Zooms the camera to about `percent`, from where it is, in one burst of wheel events. */
async function zoomTo(s: Studio, percent: number): Promise<void> {
  const at = await zoomPercent(s.page);
  const events = Math.round(Math.log(percent / at) / -0.01 / 10);
  await s.page.evaluate(async (n) => {
    for (let i = 0; i < Math.abs(n); i++) await window.__pz.wheel(1, Math.sign(n) * 10, true, 1);
  }, events);
  await settled(s.page);
}

const website: Suite = {
  ...canvasSuite("website", [resize("sidebar"), resize("thread"), commitText]),
  // As the person had it: the two pages fitted, about 13%.
  setup: async (s) => {
    const { state } = await openCanvas(s, "website");
    await zoomTo(s, 13);
    return state;
  },
};

/* ------------------------------------------------------------------ */
/* Thread                                                              */
/* ------------------------------------------------------------------ */

const LINE = [
  "I tightened the **hero's** spacing and moved the plans into one row.",
  "Here's what changed:\n\n- The nav keeps its height on scroll\n- `Pricing` reads first\n- The footer's columns wrap at 960",
  "The mobile board now matches: the cards stack, and the CTA stays in reach.",
];

const thread: Suite = {
  id: "thread",
  surface: "thread",
  about: "A canvas with a 300-line conversation: opening it, Claude streaming a reply, typing.",
  setup: async (s) => {
    const canvasId = await seedCanvas(s.page, {
      name: "Long thread",
      tokens: CORPUS_TOKENS,
      boards: row("th", ["tiny-card"]),
      thread: (agent) => {
        for (let i = 0; i < 150; i++) {
          agent.tool(`Edited ${i % 7} files`, { steps: 3, streaming: false });
          agent.say(`${LINE[i % LINE.length]} (${i + 1})`);
        }
      },
    });
    await settled(s.page);
    return { canvasId };
  },
  scenarios: [
    {
      id: "thread.open",
      title: "Open a long thread",
      headline: ["latencyMs", "longestTaskMs", "commits"],
      run: async (s, state) => {
        const m = await action(s, async () => {
          await linkTo(s.page, state.canvasId);
          await s.page.locator("#thread").getByText("(150)").waitFor({ timeout: 60_000 });
        });
        m.domNodes = await domNodes(s.page);
        return m;
      },
    },
    {
      id: "thread.stream",
      title: "Claude streams a reply",
      headline: ["fps", "mainMs", "commits"],
      run: (s, state) =>
        gesture(s, () =>
          s.page.evaluate(
            async ({ canvasId, lines }) => {
              const agent = window.ponzuFake!.backend.agent(canvasId);
              const words = lines.join(" ").split(" ");
              let text = "";
              const id = agent.say("", { streaming: true });
              // A word a frame for two seconds, as tokens arrive.
              for (let f = 0; f < 120; f++) {
                text += `${words[f % words.length]} `;
                agent.say(text, { id, streaming: true });
                await window.__pz.frame();
              }
              agent.say(text, { id, streaming: false });
            },
            { canvasId: state.canvasId, lines: LINE },
          ),
        ),
    },
    {
      id: "thread.type",
      title: "Type in the composer",
      headline: ["inputP95", "mainMs", "commits"],
      run: async (s) => {
        const field = s.page.locator("#thread").getByPlaceholder("Steer, or ask more");
        await field.click();
        const from = await s.page.evaluate(() => window.__pz.now());
        const m = await gesture(s, () =>
          s.page.keyboard.type("Make the footer quieter and the plans easier to compare", {
            delay: 25,
          }),
        );
        const keys = await s.page.evaluate(
          (from) => window.__pz.keys.filter((k) => k.start >= from).map((k) => k.ms),
          from,
        );
        m.inputP95 = round(percentile(keys, 0.95), 1);
        await field.fill("");
        return m;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

const sidebar: Suite = {
  id: "sidebar",
  surface: "sidebar",
  about: "Switching between two open canvases from the sidebar.",
  setup: async (s) => {
    const a = await seedCanvas(s.page, CANVASES.examples!.seed());
    const b = await seedCanvas(s.page, CANVASES.many!.seed());
    await linkTo(s.page, a);
    await boardsReady(s.page);
    return { canvasId: a, other: b };
  },
  scenarios: [
    {
      id: "sidebar.switch",
      title: "Switch canvases",
      headline: ["latencyMs", "longestTaskMs", "commits"],
      run: async (s, state) => {
        const rows = [state.other as string, state.canvasId];
        const runs: Measured[] = [];
        for (const id of rows) {
          runs.push(
            await action(s, async () => {
              await s.page.locator(`[data-canvas-row="${id}"]`).first().click();
              await boardsReady(s.page);
            }),
          );
        }
        // Both directions, summed: to the many small boards and back to the big pages.
        const m: Measured = {};
        for (const r of runs)
          for (const [k, v] of Object.entries(r)) m[k] = round((m[k] ?? 0) + v, 1);
        return m;
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Sandbox, as the client sees it                                      */
/* ------------------------------------------------------------------ */

/**
 * The agent, played in the page as soon as the person's message reaches the backend: it wakes,
 * says it's on it, and draws a board. The sandbox itself answers at once here, so what's timed
 * is the client's part of "time to first paint": the real sandbox's wake and the model's first
 * token are measured on the real services (live.ts).
 */
const sandbox: Suite = {
  id: "sandbox",
  surface: "sandbox",
  about:
    "The client's side of a prompt: from Enter on the create page to the first board drawn, with a sandbox that answers at once.",
  setup: async () => ({ canvasId: "" }),
  scenarios: [
    {
      id: "sandbox.first-board",
      title: "Prompt to first board",
      headline: ["latencyMs", "longestTaskMs", "commits"],
      run: async (s) => {
        const page = s.page;
        const board = BOARDS["tiny-card"].make({ id: "ab_first", name: "Hello", x: 0, y: 0 });
        await page.evaluate(() => window.ponzuFake!.command("new-canvas"));
        const field = page.getByPlaceholder(/Describe what you want to make/);
        await field.waitFor();
        await field.fill("A hello card");
        await settled(page);
        return action(s, async () => {
          await page.evaluate((artboard) => {
            const w = window.ponzuFake!;
            const known = new Set(w.backend.canvases.keys());
            const watch = () => {
              const fresh = [...w.backend.canvases.keys()].find((k) => !known.has(k));
              if (!fresh) return void requestAnimationFrame(watch);
              const agent = w.backend.agent(fresh);
              agent.say("On it.");
              const page = w.backend.canvas(fresh).sequencer.doc.pages[0]!.id;
              agent.commit([{ op: "artboard.create", page, index: 0, artboard }]);
              agent.idle();
            };
            watch();
          }, board);
          await field.press("Enter");
          await page.locator('[data-pz-board="ab_first"] [data-pz-tier="live"]').waitFor({
            timeout: 60_000,
          });
        });
      },
    },
    {
      id: "sandbox.wake",
      title: "Sandbox wakes",
      headline: ["latencyMs", "commits"],
      // A wake has no line of its own: the thread's working line at its foot says it.
      run: (s) =>
        action(s, () =>
          s.page.evaluate(async () => {
            const w = window.ponzuFake!;
            const id = [...w.backend.canvases.keys()].at(-1)!;
            const says = () =>
              document.querySelector("#thread")?.textContent?.includes("Waking up");
            w.backend.agent(id).wake();
            while (!says()) await window.__pz.frame();
            w.backend.agent(id).idle();
          }),
        ),
    },
  ],
};

export const SUITES: Suite[] = [
  website,
  canvasSuite("examples"),
  canvasSuite("dom"),
  canvasSuite("paint"),
  canvasSuite("motion"),
  canvasSuite("many"),
  canvasSuite("huge"),
  thread,
  sidebar,
  sandbox,
];
