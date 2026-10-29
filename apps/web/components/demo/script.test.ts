import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beatsOf, indexIn, lengthOf, SCRIPTS } from "./script.ts";

/** The demo's design, as files: its pages and, for each, its boards' HTML by id. */
const DIR = join(import.meta.dir, "../../public/demo/seekle.design");
const BEFORE = join(import.meta.dir, "before");
const pages = new Map<string, Map<string, string>>();
for (const page of JSON.parse(readFileSync(join(DIR, "design.json"), "utf8")).pages as {
  id: string;
  name: string;
}[]) {
  const boards = new Map<string, string>();
  const folder = join(DIR, "pages", page.name.toLowerCase().replace(/\s+/g, "-"));
  for (const name of readdirSync(folder)) {
    const html = readFileSync(join(folder, name), "utf8");
    const id = html.match(/data-artboard[^>]*data-id="([^"]+)"/)?.[1];
    if (id) boards.set(id, html);
  }
  pages.set(page.id, boards);
}
const boardsOf = (design: string) => pages.get(design) ?? new Map<string, string>();

for (const script of SCRIPTS) {
  const has = (id: string) => indexIn(script, id) >= 0;

  test(`${script.id}: every beat it names is in its timeline`, () => {
    const named = [
      ...script.pages.flatMap((p) => [p.from, p.beat]),
      ...Object.keys(script.shots),
      ...Object.values(script.rework ?? {}),
      ...Object.keys(script.tools),
      ...(script.revision ? [script.revision.from, script.revision.at] : []),
      ...script.comments.flatMap((c) => [...Object.values(beatsOf(c)), c.resolve ?? "rest"]),
      ...script.thread.flatMap((e) => ("tools" in e ? [e.from, e.to] : [e.at])),
    ];
    expect(named.filter((id) => !has(id))).toEqual([]);
    // The studio and the Claude window both read these.
    expect(has("think") && has("rest")).toBe(true);
    expect(script.beats[0]?.id).toBe("think");
    expect(new Set(script.beats.map((b) => b.id)).size).toBe(script.beats.length);
  });

  test(`${script.id}: its pages, boards and revisions are in the design`, () => {
    const all = new Map(script.pages.flatMap((p) => [...boardsOf(p.design)]));
    for (const p of script.pages) expect(pages.has(p.design)).toBe(true);
    for (const c of script.comments) expect(all.has(c.board)).toBe(true);
    for (const id of Object.keys(script.rework ?? {})) {
      expect(all.has(id)).toBe(true);
      expect(readdirSync(BEFORE)).toContain(`${id}.html`);
    }
    for (const [id, selector] of Object.entries(script.revision?.boards ?? {})) {
      const html = all.get(id) ?? "";
      expect(html).toMatch(new RegExp(`class="[^"]*\\b${selector.replace(/^\./, "")}\\b`));
    }
  });

  test(`${script.id}: makes one comment at least and resolves or answers each`, () => {
    expect(script.comments.length).toBeGreaterThan(0);
    for (const c of script.comments) expect(c.resolve ?? c.reply).toBeDefined();
  });

  test(`${script.id}: plays in about the span of the others`, () => {
    expect(lengthOf(script)).toBeGreaterThan(20_000);
    expect(lengthOf(script)).toBeLessThan(65_000);
  });
}
