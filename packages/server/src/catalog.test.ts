import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog } from "@ponzu/core";
import { LocalCatalog } from "./catalog.ts";
import { LocalWorkspace, serve } from "./index.ts";

let dir: string;

async function design(path: string, name: string, pages: Record<string, string[]>) {
  await mkdir(path, { recursive: true });
  const meta = Object.keys(pages).map((p, i) => ({ id: `pg_${i}`, name: p }));
  await writeFile(join(path, "design.json"), JSON.stringify({ ponzu: 1, name, pages: meta }));
  for (const [page, boards] of Object.entries(pages)) {
    const folder = join(path, "pages", page.toLowerCase());
    await mkdir(folder, { recursive: true });
    for (const b of boards)
      await writeFile(
        join(folder, `${b.toLowerCase()}.html`),
        `<section data-artboard data-id="ab_${b.toLowerCase()}" data-name="${b}" style="width:400px;height:300px"></section>`,
      );
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ponzu-catalog-"));
  await design(join(dir, "shop.design"), "Shop", { Home: ["Hero", "Footer"], Mobile: ["Product"] });
  await design(join(dir, "nested/deep/brand.design"), "Brand", { Logos: ["Mark"] });
  await design(join(dir, "node_modules/pkg/vendored.design"), "Vendored", { Home: ["X"] });
  await symlink(join(dir, "shop.design"), join(dir, "shop-link.design"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the catalog finds designs under its roots, skips node_modules, and lists pages and artboards", async () => {
  const catalog = new LocalCatalog({ roots: [dir], spotlight: "roots" });
  const files = await catalog.files(new Map());
  const names = files.map((f) => f.name).sort();
  // The symlink is the same folder as shop.design: one entry.
  expect(names).toEqual(["Brand", "Shop"]);
  const shop = files.find((f) => f.name === "Shop")!;
  expect(shop.pages.map((p) => p.name)).toEqual(["Home", "Mobile"]);
  expect(shop.artboards.map((a) => [a.name, a.page])).toEqual([
    ["Footer", "pg_0"],
    ["Hero", "pg_0"],
    ["Product", "pg_1"],
  ]);
  expect(shop.locked).toBe(false);
});

test("an open design's live doc wins over the disk", async () => {
  const ws = new LocalWorkspace({ cwd: dir });
  const { key, design } = await ws.open(join(dir, "shop.design"));
  design.apply({ op: "file.rename", name: "Shop, renamed" }, { kind: "user", name: "t" });
  const catalog = new LocalCatalog({ roots: [dir], spotlight: "roots" });
  const files = await catalog.files(new Map([[key, design.doc]]));
  expect(files.find((f) => f.key === key)?.name).toBe("Shop, renamed");
  await ws.closeAll();
});

test("the server's catalog is newest first, and serves nothing it doesn't list", async () => {
  const ws = new LocalWorkspace({ cwd: dir });
  const server = serve(ws, { port: 0, root: dir, spotlight: "roots" });
  try {
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      join(dir, "nested/deep/brand.design/pages/logos/mark.html"),
      `<section data-artboard data-id="ab_mark" data-name="Mark" style="width:400px;height:300px"></section>`,
    );
    const base = `http://127.0.0.1:${server.port}`;
    const catalog = (await (await fetch(`${base}/api/catalog`)).json()) as Catalog;
    expect(catalog.machines[0]).toMatchObject({ id: "local", name: "This Mac" });
    expect(catalog.files[0]?.name).toBe("Brand");
    expect(catalog.files.every((f) => f.machine === "local" && f.base === "")).toBe(true);
    const outside = encodeURIComponent(join(tmpdir(), "elsewhere.design"));
    expect((await fetch(`${base}/api/preview?file=${outside}`)).status).toBe(404);
    expect((await fetch(`${base}/peers/spare/api/catalog`)).status).toBe(404);
  } finally {
    server.stop(true);
    await ws.closeAll();
  }
});
