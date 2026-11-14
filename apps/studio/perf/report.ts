/*
 * The pull request's comment: head against base, surface by surface, with each scenario's
 * headline numbers and how main has moved over its recent merges. Pure, so tested on its own
 * (report.test.ts). It reports; it never fails a check.
 */
import {
  type Aggregate,
  aggregate,
  compare,
  HOLDS_FPS,
  METRICS,
  round,
  scrollsOnly,
  TARGET_FPS,
  type Verdict,
} from "./metrics.ts";

/** The marker the workflow finds its own comment by, to update it in place. */
export const MARKER = "<!-- ponzu-perf -->";

/** Each scenario's metrics, every round's value. */
export type Runs = Record<string, Record<string, number[]>>;

export interface Results {
  date: string;
  machine: string;
  rounds: number;
  head: { sha: string | null; runs: Runs };
  base: { sha: string | null; runs: Runs } | null;
  /** Each scenario's place in the report. */
  scenarios: {
    id: string;
    suite: string;
    surface: string;
    title: string;
    headline: string[];
  }[];
  suites: { id: string; surface: string; about: string }[];
  errors: { build: "head" | "base"; at: string; message: string }[];
}

/** One merge to main: each scenario's medians. */
export interface HistoryEntry {
  sha: string;
  date: string;
  medians: Record<string, Record<string, number>>;
}

export function historyEntry(results: Results): HistoryEntry {
  const medians: HistoryEntry["medians"] = {};
  for (const [id, metrics] of Object.entries(results.head.runs)) {
    medians[id] = {};
    for (const [name, values] of Object.entries(metrics))
      medians[id]![name] = aggregate(values).median;
  }
  return { sha: results.head.sha ?? "", date: results.date, medians };
}

export function parseHistory(text: string): HistoryEntry[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as HistoryEntry];
      } catch {
        return [];
      }
    });
}

const BARS = "▁▂▃▄▅▆▇█";

/** A sparkline of `values`, oldest first; a flat line when they don't move. */
export function sparkline(values: number[]): string {
  if (!values.length) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return values
    .map((v) => (hi === lo ? BARS[3] : BARS[Math.round(((v - lo) / (hi - lo)) * 7)]))
    .join("");
}

export function format(name: string, v: number): string {
  const info = METRICS[name];
  const unit = info?.unit ?? "";
  const n =
    Math.abs(v) >= 1000
      ? round(v).toLocaleString("en-US")
      : Number.isInteger(v)
        ? String(v)
        : String(round(v, 1));
  if (unit === "ms") return `${n} ms`;
  if (unit === "fps") return `${n} / ${TARGET_FPS} fps`;
  return n;
}

function delta(base: Aggregate, head: Aggregate): string {
  if (base.median === 0) return head.median === 0 ? "" : "new";
  const pct = ((head.median - base.median) / base.median) * 100;
  return `${pct > 0 ? "+" : ""}${round(pct)}%`;
}

const MARK: Record<Verdict, string> = { better: "🟢", worse: "🔴", same: "" };

interface Cell {
  text: string;
  verdict: Verdict;
}

function cell(results: Results, id: string, name: string): Cell {
  const h = results.head.runs[id]?.[name];
  if (!h?.length) return { text: "—", verdict: "same" };
  const head = aggregate(h);
  const b = results.base?.runs[id]?.[name];
  if (!b?.length) return { text: format(name, head.median), verdict: "same" };
  const base = aggregate(b);
  const verdict = compare(name, base, head);
  const text =
    verdict === "same"
      ? format(name, head.median)
      : `${format(name, head.median)} ${MARK[verdict]} ${delta(base, head)}`;
  return { text, verdict };
}

const SURFACES: Record<string, string> = {
  canvas: "Canvas",
  panes: "Panes",
  thread: "Thread",
  sidebar: "Sidebar",
  sandbox: "Sandbox (client side)",
};

/** The comment, in Markdown. `history` is main's recent merges, oldest first. */
export function report(results: Results, history: HistoryEntry[] = []): string {
  const short = (sha: string | null, or: string) => (sha ? `\`${sha.slice(0, 7)}\`` : or);
  const out: string[] = [MARKER, "## Performance"];
  const against = results.base
    ? `${short(results.head.sha, "head")} against ${short(results.base.sha, "base")}, ${results.rounds} rounds each, interleaved`
    : `${short(results.head.sha, "head")}, ${results.rounds} rounds`;
  // run.ts names Electron in the machine when it measured the desktop app (--electron, --cdp).
  const where = /\bElectron\//.test(results.machine) ? "the desktop app" : "headless Chrome";
  out.push(
    `<sub>${against} · ${results.machine} · ${where} on Ponzu Cloud in memory · reported, never enforced</sub>`,
    "",
  );

  // The target first: which gestures hold 120 frames a second, and how far short the rest are.
  const desktop = where === "the desktop app";
  const gestures = results.scenarios.filter(
    (sc) =>
      (results.head.runs[sc.id]?.fps ?? []).some((v) => v > 0) && (desktop || !scrollsOnly(sc.id)),
  );
  if (gestures.length) {
    const fps = (id: string) => aggregate(results.head.runs[id]!.fps!).median;
    const short = gestures
      .filter((sc) => fps(sc.id) < HOLDS_FPS)
      .sort((a, b) => fps(a.id) - fps(b.id));
    out.push(
      `**${gestures.length - short.length} of ${gestures.length} gestures hold ${TARGET_FPS} fps** (a ProMotion display; ${round(1000 / TARGET_FPS, 1)} ms a frame).` +
        (short.length
          ? ` Short of it: ${short
              .slice(0, 8)
              .map((sc) => `\`${sc.id}\` ${round(fps(sc.id))}`)
              .join(", ")}${short.length > 8 ? `, and ${short.length - 8} more` : ""}.`
          : ""),
      "",
    );
  }

  // What moved: each scenario's headline numbers. The rest are marked in the details.
  const moved: string[] = [];
  let better = 0;
  let worse = 0;
  let same = 0;
  if (results.base) {
    for (const sc of results.scenarios) {
      for (const name of sc.headline) {
        if (!results.head.runs[sc.id]?.[name]) continue;
        const c = cell(results, sc.id, name);
        if (c.verdict === "better") better++;
        else if (c.verdict === "worse") worse++;
        else same++;
        if (c.verdict !== "same")
          moved.push(
            `- ${MARK[c.verdict]} **${sc.id}** ${METRICS[name]?.label ?? name}: ${c.text.replace(/ [🟢🔴]/u, " ·")}`,
          );
      }
    }
    out.push(
      worse || better
        ? `**${better} better, ${worse} worse** of the ${better + worse + same} headline numbers; the rest within noise.`
        : `**No change** beyond noise in the ${same} headline numbers.`,
      "",
    );
    if (moved.length) {
      // What got worse first.
      const worseFirst = [
        ...moved.filter((l) => l.startsWith("- 🔴")),
        ...moved.filter((l) => !l.startsWith("- 🔴")),
      ];
      out.push(...worseFirst.slice(0, 15));
      if (moved.length > 15) out.push(`- …and ${moved.length - 15} more, below.`);
      out.push("");
    }
  }

  // Each surface: its scenarios' headline numbers, and main's trend for the first of them.
  const bySurface = new Map<string, Results["scenarios"]>();
  for (const sc of results.scenarios) {
    const list = bySurface.get(sc.surface) ?? [];
    list.push(sc);
    bySurface.set(sc.surface, list);
  }
  for (const [surface, list] of bySurface) {
    out.push(`### ${SURFACES[surface] ?? surface}`, "");
    out.push("| Scenario | Headline | | | Main, last merges |", "|---|---|---|---|---|");
    for (const sc of list) {
      const cells = sc.headline.map((name) => {
        const c = cell(results, sc.id, name);
        return `${METRICS[name]?.label ?? name}: ${c.text}`;
      });
      while (cells.length < 3) cells.push("");
      const first = sc.headline[0]!;
      const trend = history
        .map((h) => h.medians[sc.id]?.[first])
        .filter((v): v is number => typeof v === "number")
        .slice(-20);
      const spark = trend.length >= 2 ? `${sparkline(trend)} ${format(first, trend.at(-1)!)}` : "";
      out.push(`| \`${sc.id}\` ${sc.title} | ${cells.join(" | ")} | ${spark} |`);
    }
    out.push("");
  }

  // Everything, for whoever wants it.
  out.push("<details><summary>Every number</summary>", "");
  for (const sc of results.scenarios) {
    const metrics = Object.keys(results.head.runs[sc.id] ?? {});
    if (!metrics.length) continue;
    out.push(`**${sc.id}** ${sc.title}`, "");
    out.push(
      results.base
        ? "| Metric | Base | Head | Δ |\n|---|---|---|---|"
        : "| Metric | Head |\n|---|---|",
    );
    for (const name of metrics) {
      const head = aggregate(results.head.runs[sc.id]![name]!);
      const b = results.base?.runs[sc.id]?.[name];
      const range = (a: Aggregate) =>
        a.n > 1 && a.min !== a.max
          ? ` <sub>${format(name, a.min)}–${format(name, a.max)}</sub>`
          : "";
      if (results.base && b?.length) {
        const base = aggregate(b);
        const v = compare(name, base, head);
        out.push(
          `| ${METRICS[name]?.label ?? name} | ${format(name, base.median)}${range(base)} | ${format(name, head.median)}${range(head)} | ${MARK[v]} ${delta(base, head)} |`,
        );
      } else {
        out.push(
          `| ${METRICS[name]?.label ?? name} | ${format(name, head.median)}${range(head)} |`,
        );
      }
    }
    out.push("");
  }
  out.push("</details>", "");

  if (results.errors.length) {
    out.push("<details><summary>⚠️ Scenarios that didn't run</summary>", "");
    for (const e of results.errors)
      out.push(`- ${e.build} · \`${e.at}\`: ${e.message.split("\n")[0]}`);
    out.push("", "</details>", "");
  }

  out.push(
    "<details><summary>How to read this</summary>",
    "",
    "Counts (restyled, laid out, React commits) are what the browser and React did during a gesture of a fixed number of frames: nearly the same on any machine, so one is marked when it moves 3%. Times are this runner's, compared only with the base built and run beside it, and marked when they move 10%. Either is marked only when the rounds' ranges don't overlap. Nothing here fails a check.",
    "",
    ...results.suites.map((s) => `- **${s.id}**: ${s.about}`),
    "",
    ...Object.entries(METRICS).map(([, m]) => `- *${m.label}*: ${m.means}`),
    "",
    `The target is ${TARGET_FPS} frames a second, a ProMotion display's. Chrome is never held to 60: the harness draws frames as a ${TARGET_FPS} Hz display would, so a frame that fits ${round(1000 / TARGET_FPS, 1)} ms reads as ${TARGET_FPS} fps and one that doesn't reads as long as it took. A gesture holds the target at ${round(HOLDS_FPS)} fps or more. In headless Chrome a pan, whose frames only scroll, can't go past about 57 fps however cheap it is, so pans count only on the desktop app.`,
    "",
    "Run it yourself: `bun apps/studio/perf/run.ts` (apps/studio/perf/README.md).",
    "</details>",
  );
  return out.join("\n");
}
