import { expect, test } from "bun:test";
import type { Artboard, Doc } from "@ponzu/core";
import { previewArtboard } from "./preview.ts";

const board = (id: string, x: number, y: number, width: number, height: number): Artboard => ({
  id,
  name: id,
  x,
  y,
  root: {
    kind: "el",
    id,
    tag: "section",
    attrs: {},
    style: { width: `${width}px`, height: `${height}px` },
    children: [],
  },
});

const doc = (artboards: Artboard[]): Doc => ({
  name: "Shop",
  pages: [{ id: "p1", name: "Home", artboards }],
  tokens: "",
  threads: [],
  notes: {},
});

test("lays the first page's artboards out like the canvas, scaled to fit", () => {
  const ab = previewArtboard(doc([board("a", 0, 0, 1440, 900), board("b", 1540, 0, 390, 844)]))!;
  expect(ab.root.style.width).toBe("512px");
  const [stage] = ab.root.children as [any];
  const [a, b] = stage.children;
  expect(a.attrs["data-artboard"]).toBe("");
  expect(Number.parseFloat(b.style.left) - Number.parseFloat(a.style.left)).toBe(1540);
  expect(stage.style.transform).toMatch(/^scale\(0\.\d+\)$/);
});

test("keeps an icon-friendly shape and skips empty files", () => {
  const wide = previewArtboard(doc([board("a", 0, 0, 4000, 200)]))!;
  expect(Number.parseFloat(wide.root.style.height!)).toBe(320);
  const tall = previewArtboard(doc([board("a", 0, 0, 390, 6000)]))!;
  expect(Number.parseFloat(tall.root.style.width!)).toBe(384);
  expect(previewArtboard(doc([]))).toBeNull();
});
