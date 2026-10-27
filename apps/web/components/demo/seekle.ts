import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type Artboard, type PageState, parseArtboardFile } from "@ponzu/core";
import { readBag } from "@ponzu/store";

/**
 * The design the product demo draws: boards from Seekle, a game on the App Store, as Claude made
 * them in Ponzu, from the app's screens and animations to the App Store screenshots. They're the
 * real files, five pages of them, read at build time (app/demo/seekle.json) and drawn by Ponzu's
 * own artboard view, so the demo shows exactly what the canvas does.
 */
const DIR = join(process.cwd(), "public/demo/seekle.design");

/**
 * Boards as they were when you commented on them, replayed from the design's journal: Claude
 * revises them while you watch, into the design's own.
 */
const BEFORE = join(process.cwd(), "components/demo/before");

export interface DemoDesign {
  tokens: string;
  pages: PageState[];
  /** Where the design's `assets/` are served from, for the artboards' images. */
  assets: string;
  /** Boards as they were before Claude revised them, by id. */
  before: Record<string, Artboard>;
}

function texts(dir: string, bag: Record<string, string> = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) texts(path, bag);
    else if (/\.(html|css|json|md)$/.test(entry.name))
      bag[relative(DIR, path)] = readFileSync(path, "utf8");
  }
  return bag;
}

export function readSeekle(): DemoDesign {
  const { doc } = readBag(texts(DIR), "seekle");
  const before: Record<string, Artboard> = {};
  for (const name of readdirSync(BEFORE)) {
    const id = name.replace(/\.html$/, "");
    before[id] = parseArtboardFile(readFileSync(join(BEFORE, name), "utf8"), {
      id,
      name: id,
    }).artboard;
  }
  return { tokens: doc.tokens, pages: doc.pages, assets: "/demo/seekle.design", before };
}
