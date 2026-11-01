import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseArtboardFile } from "@ponzu/core";
import { actCore } from "./act.ts";
import { ChromiumRenderer, findChromium } from "./chromium.ts";

const core = actCore();

describe("scene scripts parse", () => {
  test("beats, options, togetherness and comments", () => {
    const s = core.parse(`
// a comment
once
move @"Invite button" dur=500 at=0.8,0.5
& show [data-name="Toast card"] rise   // trailing comment
set .row data-done aria-selected=true
nope .x
`);
    expect(s.loop).toBe(false);
    expect(s.lines.map((l) => [l.verb, l.args, l.opts, l.with])).toEqual([
      ["move", ["@Invite button"], { dur: "500", at: "0.8,0.5" }, false],
      ["show", ['[data-name="Toast card"]', "rise"], {}, true],
      ["set", [".row", "data-done"], { "aria-selected": "true" }, false],
    ]);
    expect(s.lines[1]!.text).toBe('& show [data-name="Toast card"] rise');
    expect(s.issues).toEqual([{ line: 7, message: `"nope" isn't a beat` }]);
  });

  test("times and curves", () => {
    expect(core.ms("400")).toBe(400);
    expect(core.ms("1.5s")).toBe(1500);
    expect(core.ms("soon")).toBeNull();
    expect(core.curve("house", "linear")).toBe("cubic-bezier(0.65, 0, 0.1, 1)");
    expect(core.curve("steps(3)", "linear")).toBe("steps(3)");
    const e = core.easer("cubic-bezier(0.65, 0, 0.35, 1)");
    expect(e(0)).toBe(0);
    expect(e(1)).toBe(1);
    expect(e(0.5)).toBeCloseTo(0.5, 3);
  });

  test("typing is uneven but the same every time", () => {
    const a = core.cadence([..."hello, world"], 40, "seed");
    expect(a).toEqual(core.cadence([..."hello, world"], 40, "seed"));
    expect(a[0]).toBe(0);
    const gaps = a.slice(1).map((t, i) => t - a[i]!);
    expect(new Set(gaps).size).toBeGreaterThan(3);
    // A comma holds longer than a letter.
    expect(gaps[5]!).toBeGreaterThan(Math.min(...gaps.slice(0, 4)));
  });

  test("numbers roll from the right, keycaps read as glyphs", () => {
    expect(core.columns("$1,180", "$1,240")).toEqual([
      { from: "$", to: "$" },
      { from: "1", to: "1" },
      { from: ",", to: "," },
      { from: "1", to: "2" },
      { from: "8", to: "4" },
      { from: "0", to: "0" },
    ]);
    // A digit that arrives has nothing to roll from.
    expect(core.columns("99", "100")[0]).toEqual({ from: "", to: "1" });
    expect(core.caps("cmd+shift+k")).toEqual(["⌘", "⇧", "K"]);
  });

  test("keyframes hold between changes and jump where a change takes no time", () => {
    const kf = core.frames(
      "0",
      [
        { t0: 100, t1: 300, from: "0", to: "1", ease: "ease-out" },
        { t0: 600, t1: 600, from: "1", to: "0.5", ease: "linear" },
      ],
      1000,
    );
    expect(kf).toEqual([
      { offset: 0, value: "0", easing: "linear" },
      { offset: 0.1, value: "0", easing: "ease-out" },
      { offset: 0.3, value: "1", easing: "linear" },
      { offset: 0.6, value: "1", easing: "linear" },
      { offset: 0.6, value: "0.5", easing: "linear" },
      { offset: 1, value: "0.5", easing: "linear" },
    ]);
  });

  test("a hand's path bows and lands", () => {
    const path = core.arc({ x: 0, y: 0 }, { x: 100, y: 0 }, "linear", 10, 10);
    expect(path[0]).toMatchObject({ t: 0, x: 0, y: 0 });
    expect(path[10]).toMatchObject({ t: 1, x: 100 });
    expect(Math.abs(path[5]!.y)).toBeCloseTo(10, 5);
  });
});

const chromium = findChromium();
setDefaultTimeout(60_000);

describe.skipIf(!chromium)("scenes in Chromium", () => {
  const renderer = new ChromiumRenderer({ executablePath: chromium ?? undefined });
  afterAll(() => renderer.close(), 30_000);

  const artboard = parseArtboardFile(
    `<section data-artboard data-id="ab_s" data-name="Scene" style="width:480px;height:280px;padding:32px;gap:12px;background:#fff">
<style>
.go{transition:background-color .15s ease;cursor:pointer}
.go:hover{background-color:rgb(200, 30, 30) !important}
</style>
<button data-id="n_go" data-name="Go" class="go" style="align-self:flex-start;padding:10px 16px;border:0;background-color:rgb(20, 20, 20);color:#fff">Go</button>
<span data-id="n_total" data-name="Total" style="font:600 18px/24px sans-serif">$1,240</span>
<div data-id="n_toast" data-name="Toast" style="padding:10px;background:#111;color:#fff">Sent</div>
<script data-id="n_act" type="ponzu/act">
wait 300
click @Go
& show @Toast rise
count @Total from $1,180
poster
wait 800
hide @Toast
reset
</script>
</section>`,
    { id: "ab_s", name: "Scene" },
  ).artboard;
  const base = { artboard, tokens: "" };

  test("compiles into one looping timeline and stills show its poster", async () => {
    const out = await renderer.render({ ...base, lint: true });
    const m = out.motion!;
    expect(m.act).toBeDefined();
    const act = m.act!;
    expect(act.loop).toBe(true);
    expect(act.animations).toBeGreaterThan(4);
    expect(act.beats.map((b) => b.text)).toEqual([
      "wait 300",
      "click @Go",
      "& show @Toast rise",
      "count @Total from $1,180",
      "poster",
      "wait 800",
      "hide @Toast",
      "reset",
    ]);
    const poster = act.beats.find((b) => b.text === "poster")!;
    expect(act.poster).toBe(poster.start);
    expect(m.at).toBe(act.poster);
    expect(m.loops).toBe(true);
    expect(m.cycle).toBe(act.duration);
    // The scene's own animations aren't listed one by one.
    expect(m.animations).toEqual([]);
    expect(out.issues).toEqual([]);
    const first = await renderer.render({ ...base, at: 0 });
    expect(Buffer.from(first.bytes).equals(Buffer.from(out.bytes))).toBe(false);
  });

  test("record films a storyboard, one frame where each beat lands", async () => {
    const out = await renderer.record({ ...base, lint: true });
    const labels = out.steps.map((s) => s.label.replace(/^\d+ms /, ""));
    // In time order. A beat with & after a click starts at its press, so the toast lands after it.
    expect(labels).toEqual([
      "start",
      "wait 300",
      "click @Go",
      "& show @Toast rise",
      "count @Total from $1,180",
      "wait 800",
      "hide @Toast",
    ]);
    // frames, from or to film evenly, as for any animation.
    const even = await renderer.record({ ...base, frames: 4 });
    expect(even.steps.map((s) => s.t)).toEqual([
      0,
      even.steps[1]!.t,
      even.steps[2]!.t,
      even.steps[3]!.t,
    ]);
    expect(even.steps[3]!.t).toBe(out.motion.act!.duration);
  });

  test("says what it can't find or play", async () => {
    const broken = parseArtboardFile(
      `<section data-artboard data-id="ab_b" style="width:300px;height:200px">
<p data-id="n_p">Hi</p>
<script data-id="n_act" type="ponzu/act">
click @Missing
fly away
count @n from
set p onclick=alert(1) href=javascript:alert(2) data-id=n_x data-ok
</script>
</section>`,
      { id: "ab_b", name: "Broken" },
    ).artboard;
    const out = await renderer.render({ artboard: broken, tokens: "", lint: true });
    const messages = out.issues.filter((i) => i.kind === "act").map((i) => i.message);
    expect(messages).toContain(`line 3: "fly" isn't a beat`);
    expect(messages).toContain("line 2: nothing matches @Missing");
    expect(messages.some((m) => m.startsWith("line 4: nothing matches @n"))).toBe(true);
    expect(messages.some((m) => m.includes("loops without a reset"))).toBe(true);
    // set changes looks, never behavior: no handlers, URLs or Ponzu's own ids.
    for (const name of ["onclick", "href", "data-id"])
      expect(messages.some((m) => m.startsWith(`line 5: ${name} isn't a state`))).toBe(true);
    expect(messages.some((m) => m.includes("data-ok"))).toBe(false);
    expect(out.issues.every((i) => i.kind !== "act" || i.id === "n_act")).toBe(true);
  });
});
