import { expect, test } from "bun:test";
import { type Doc, emptyDoc, parseArtboardFile } from "@ponzu/core";
import { renderToStaticMarkup } from "react-dom/server";
import { Canvas } from "./Canvas.tsx";
import { MemorySource, viewOnly } from "./connection.ts";

function doc(): Doc {
  const d = emptyDoc("Kettle");
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="ab_a" data-name="Home" style="width:400px;height:300px"><img src="assets/logo.png"></section>`,
    { id: "ab_a", name: "Home" },
  );
  d.pages.push({ id: "pg_a", name: "Brand", artboards: [artboard] });
  return d;
}

test("a memory source carries the asset base it was given", () => {
  const base = "https://raw.githubusercontent.com/o/r/abc123/kettle.design";
  expect(new MemorySource(doc(), undefined, { assetBase: base }).assetBase).toBe(base);
  expect(new MemorySource(doc()).assetBase).toBeUndefined();
});

test("a view-only source never edits, but still shows the source's changes", () => {
  const changes: string[] = [];
  const inner = new MemorySource(doc(), (_d, op) => changes.push(op.op), { assetBase: "/a" });
  const view = viewOnly(inner);
  view.apply({ op: "artboard.delete", id: "ab_a" });
  view.apply({ op: "page.update", id: "pg_a", name: "Renamed" });
  view.undo();
  view.redo();
  expect(changes).toEqual([]);
  expect(view.getState().doc?.pages[0]?.artboards).toHaveLength(1);
  expect(view.getState().doc?.pages[0]?.name).toBe("Brand");

  let seen = 0;
  const off = view.subscribe(() => seen++);
  inner.apply({ op: "page.update", id: "pg_a", name: "Moved on" });
  off();
  expect(seen).toBe(1);
  expect(view.getState().doc?.pages[0]?.name).toBe("Moved on");
  expect(view.assetBase).toBe("/a");
});

test("a read-only canvas has no comment tool or new-page button", () => {
  const source = new MemorySource(doc());
  const editable = renderToStaticMarkup(<Canvas source={source} />);
  const readOnly = renderToStaticMarkup(<Canvas source={source} readOnly />);
  expect(editable).toContain('aria-label="New page"');
  expect(editable).toContain('aria-label="Comment"');
  expect(readOnly).not.toContain('aria-label="New page"');
  expect(readOnly).not.toContain('aria-label="Comment"');
  // Looking around stays: pages, zoom and the select and hand tools.
  expect(readOnly).toContain("Brand");
  expect(readOnly).toContain('aria-label="Zoom to fit"');
  expect(readOnly).toContain('aria-label="Hand"');
});

test("a host can pick the page", () => {
  const d = doc();
  const { artboard } = parseArtboardFile(
    `<section data-artboard data-id="ab_b" data-name="Hero" style="width:400px;height:300px"></section>`,
    { id: "ab_b", name: "Hero" },
  );
  d.pages.push({ id: "pg_b", name: "Website", artboards: [artboard] });
  const source = new MemorySource(d);
  const first = renderToStaticMarkup(<Canvas source={source} footer={false} />);
  const second = renderToStaticMarkup(<Canvas source={source} footer={false} page="pg_b" />);
  expect(first).toContain('data-artboard-host="ab_a"');
  expect(second).toContain('data-artboard-host="ab_b"');
  expect(second).not.toContain('data-artboard-host="ab_a"');
  // Without the footer, no page tabs.
  expect(second).not.toContain('aria-label="Pages"');
});
