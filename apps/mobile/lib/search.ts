import type { PhoneFile } from "./files";

/**
 * Search over every Mac's designs: files by name, project and branch, and
 * frames (artboards) by name, page and design. Every word of the query must
 * appear somewhere, as a substring, case and accents aside. Plain enough to
 * run on every keystroke over a few thousand artboards.
 */

/** A run of `text`, marked where it matched. */
export type Run = { text: string; hit: boolean };

export interface FileHit {
  file: PhoneFile;
  name: Run[];
  score: number;
}

export interface FrameHit {
  file: PhoneFile;
  artboard: PhoneFile["artboards"][number];
  pageName: string;
  name: Run[];
  /** "<page> in <design>", marked. */
  where: Run[];
  score: number;
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function words(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** `text` in runs, every place a word matches marked. */
export function mark(text: string, ws: string[]): Run[] {
  const f = fold(text);
  const hit = new Array<boolean>(text.length).fill(false);
  for (const w of ws) {
    let i = f.indexOf(w);
    while (i >= 0) {
      for (let j = i; j < i + w.length; j++) hit[j] = true;
      i = f.indexOf(w, i + w.length);
    }
  }
  const runs: Run[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.hit === hit[i]) last.text += text[i];
    else runs.push({ text: text[i]!, hit: hit[i]! });
  }
  return runs;
}

/** How well `fields` match: 0 when a word is missing; more for matches in the first field, at a word start. */
function score(ws: string[], fields: string[]): number {
  const folded = fields.map(fold);
  let total = 0;
  for (const w of ws) {
    let best = 0;
    folded.forEach((f, i) => {
      const at = f.indexOf(w);
      if (at < 0) return;
      const start = at === 0 || /\W/.test(f[at - 1]!);
      best = Math.max(best, (i === 0 ? 3 : 1) + (start ? 1 : 0));
    });
    if (!best) return 0;
    total += best;
  }
  return total;
}

export function search(
  files: PhoneFile[],
  query: string,
  limit = { files: 20, frames: 40 },
): { files: FileHit[]; frames: FrameHit[] } {
  const ws = words(query);
  if (!ws.length) return { files: [], frames: [] };
  const fileHits: FileHit[] = [];
  const frameHits: FrameHit[] = [];
  for (const file of files) {
    const s = score(ws, [file.name, file.git?.projectName ?? "", file.git?.branch ?? ""]);
    if (s) fileHits.push({ file, name: mark(file.name, ws), score: s + file.modified / 1e15 });
    const pages = new Map(file.pages.map((p) => [p.id, p.name]));
    for (const artboard of file.artboards) {
      const pageName = pages.get(artboard.page) ?? "";
      const fs = score(ws, [artboard.name, pageName, file.name]);
      if (!fs) continue;
      frameHits.push({
        file,
        artboard,
        pageName,
        name: mark(artboard.name, ws),
        where: [...mark(pageName, ws), { text: " in ", hit: false }, ...mark(file.name, ws)],
        score: fs + file.modified / 1e15,
      });
    }
  }
  fileHits.sort((a, b) => b.score - a.score);
  frameHits.sort((a, b) => b.score - a.score);
  return { files: fileHits.slice(0, limit.files), frames: frameHits.slice(0, limit.frames) };
}
