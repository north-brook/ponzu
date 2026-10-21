import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import { LocalCatalog } from "./catalog.ts";
import { LocalWorkspace, serve } from "./index.ts";

let dir: string;

async function design(
  path: string,
  name: string,
  pages: Record<string, string[]>,
  extra: { example?: true } = {},
) {
  await mkdir(path, { recursive: true });
  const meta = Object.keys(pages).map((p, i) => ({ id: `pg_${i}`, name: p }));
  await writeFile(
    join(path, "design.json"),
    JSON.stringify({ ponzu: 1, name, ...extra, pages: meta }),
  );
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

test("a preview older than an edit to a closed design is redrawn, and its URL changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ponzu-stale-"));
  const path = join(root, "site.design");
  await design(path, "Site", { Home: ["Hero"] });
  let draws = 0;
  const renderer = {
    render: async () => ({ bytes: new Uint8Array([++draws]) }),
    close: async () => {},
  } as unknown as Renderer;
  const ws = new LocalWorkspace({ cwd: root, renderer, previews: false });
  const server = serve(ws, { port: 0, root, spotlight: "roots" });
  const base = `http://127.0.0.1:${server.port}`;
  const preview = async () => {
    const catalog = (await (await fetch(`${base}/api/catalog`)).json()) as Catalog;
    const url = catalog.files.find((f) => f.name === "Site")!.preview!;
    return { url, bytes: [...new Uint8Array(await (await fetch(`${base}${url}`)).arrayBuffer())] };
  };
  try {
    const first = await preview();
    // Light is drawn after dark.
    expect(first.bytes).toEqual([2]);
    expect((await preview()).bytes).toEqual([2]);
    // Changed on disk while closed, as a pull would.
    const later = new Date(Date.now() + 5000);
    const hero = join(path, "pages/home/hero.html");
    await writeFile(
      hero,
      `<section data-artboard data-id="ab_hero" data-name="Hero" style="width:500px;height:300px"></section>`,
    );
    await utimes(hero, later, later);
    await new Promise((r) => setTimeout(r, 3100));
    const second = await preview();
    expect(second.url).not.toBe(first.url);
    expect(second.bytes).toEqual([4]);
  } finally {
    server.stop(true);
    await ws.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop, Documents and Downloads are guarded; other folders aren't", async () => {
  const { guardOf } = await import("./catalog.ts");
  const { homedir } = await import("node:os");
  const inside = join(homedir(), "Documents", "x.design");
  expect(guardOf(inside)).toBe(join(homedir(), "Documents"));
  expect(guardOf(`${join(homedir(), "Documents")}/`)).toBe(join(homedir(), "Documents"));
  expect(guardOf(join(dir, "shop.design"))).toBeNull();
  // A design outside the guarded folders is read in full.
  const catalog = new LocalCatalog({ roots: [], spotlight: "roots" });
  catalog.add(join(dir, "nested/deep/brand.design"));
  const files = await catalog.files(new Map());
  expect(files.map((f) => [f.name, f.locked])).toEqual([["Brand", false]]);
});

describe("example designs", () => {
  let root: string;
  const sample = () => join(root, "repo/examples/sample.design");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ponzu-examples-"));
    await design(join(root, "repo/mine.design"), "Mine", { Home: ["Hero"] });
    await design(sample(), "Sample", { Home: ["Hero"] }, { example: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const names = async (catalog: LocalCatalog, open = new Map()) =>
    (await catalog.files(open)).map((f) => f.name).sort();

  test("a found example isn't listed, open or not, until the person opens it", async () => {
    const catalog = new LocalCatalog({ roots: [root], spotlight: "roots" });
    expect(await names(catalog)).toEqual(["Mine"]);
    // Opened for an agent: in the workspace, not on the home screen.
    const ws = new LocalWorkspace({ cwd: root });
    const { key, design: d } = await ws.open(sample());
    catalog.add(key);
    expect(d.doc.example).toBe(true);
    expect(await names(catalog, new Map([[key, d.doc]]))).toEqual(["Mine"]);
    // Through a symlinked path too, once the person opens it.
    await symlink(join(root, "repo"), join(root, "link"));
    catalog.opened(join(root, "link/examples/sample.design"));
    expect(await names(catalog, new Map([[key, d.doc]]))).toEqual(["Mine", "Sample"]);
    await ws.closeAll();
  });

  test("an example the person opens stays listed after a restart; one named to serve doesn't", async () => {
    const stateFile = join(root, "state/catalog.json");
    const first = new LocalCatalog({ roots: [], spotlight: "roots", stateFile });
    first.opened(sample());
    expect(await names(first)).toEqual(["Sample"]);
    expect(await names(new LocalCatalog({ roots: [], spotlight: "roots", stateFile }))).toEqual([]);
    first.opened(sample(), { remember: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(await readFile(stateFile, "utf8")).opened).toHaveLength(1);
    // Listed even with nothing scanned: Spotlight skips hidden folders like .t3 worktrees.
    expect(await names(new LocalCatalog({ roots: [], spotlight: "roots", stateFile }))).toEqual([
      "Sample",
    ]);
  });

  test("over HTTP: an agent's registration hides an example, the person's open lists it", async () => {
    const ws = new LocalWorkspace({ cwd: root });
    const server = serve(ws, { port: 0, root, spotlight: "roots" });
    const base = `http://127.0.0.1:${server.port}`;
    const list = async () =>
      ((await (await fetch(`${base}/api/catalog`)).json()) as Catalog).files.map((f) => f.name);
    const post = (body: object) =>
      fetch(`${base}/api/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      // `ponzu mcp` from the repo (and older clients that don't say who): both open, so
      // agents can use them, but only Mine is listed.
      await post({ path: join(root, "repo/mine.design"), by: "agent" });
      await post({ path: sample() });
      expect(ws.designs().length).toBe(2);
      expect((await list()).sort()).toEqual(["Mine"]);
      await post({ path: sample(), by: "person" });
      expect((await list()).sort()).toEqual(["Mine", "Sample"]);
    } finally {
      server.stop(true);
      await ws.closeAll();
    }
  });

  test("`ponzu serve examples/x.design` lists the example it was given", async () => {
    const ws = new LocalWorkspace({ cwd: root });
    const { key } = await ws.open(sample());
    const server = serve(ws, { port: 0, root, spotlight: "roots", opened: [key] });
    try {
      const catalog = (await (
        await fetch(`http://127.0.0.1:${server.port}/api/catalog`)
      ).json()) as Catalog;
      expect(catalog.files.map((f) => f.name).sort()).toEqual(["Mine", "Sample"]);
    } finally {
      server.stop(true);
      await ws.closeAll();
    }
  });
});
