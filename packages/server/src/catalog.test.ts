import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
    expect((await fetch(`${base}/files/${outside}/assets/logo.png`)).status).toBe(404);
    // A listed design's assets load without opening it, for its preview and thumbnails.
    const brand = join(dir, "nested/deep/brand.design");
    await mkdir(join(brand, "assets"), { recursive: true });
    await writeFile(join(brand, "assets/logo.png"), "png");
    const logo = await fetch(`${base}/files/${encodeURIComponent(brand)}/assets/logo.png`);
    expect(await logo.text()).toBe("png");
    // Videos seek only when their bytes come in ranges.
    await writeFile(join(brand, "assets/clip.webm"), "0123456789");
    const clip = `${base}/files/${encodeURIComponent(brand)}/assets/clip.webm`;
    const part = await fetch(clip, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect((await fetch(clip, { headers: { range: "bytes=10-" } })).status).toBe(416);
    expect(ws.get(brand)).toBeUndefined();
    expect(ws.assetBase(brand)).toBe(`${base}/files/${encodeURIComponent(brand)}`);
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

test("over HTTP: the studio archives and restores a design it lists, and nothing else", async () => {
  const ws = new LocalWorkspace({ cwd: dir });
  const server = serve(ws, { port: 0, root: dir, spotlight: "roots" });
  const base = `http://127.0.0.1:${server.port}`;
  const shelf = (body: object, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/shelf`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const shop = async () =>
    ((await (await fetch(`${base}/api/catalog`)).json()) as Catalog).files.find((f) =>
      f.key.endsWith("/shop.design"),
    );
  try {
    const key = (await shop())!.key;
    expect((await shelf({ key, action: "archive" })).status).toBe(200);
    expect(await shop()).toMatchObject({ shelf: "archived", archived: expect.any(Number) });
    expect((await shelf({ key, action: "restore" })).status).toBe(200);
    // Back where it was: Scratch, since it's in the system's temporary folder.
    expect((await shop())?.shelf).toBe("scratch");
    expect((await shelf({ key: join(tmpdir(), "else.design"), action: "archive" })).status).toBe(
      404,
    );
    expect((await shelf({ key, action: "delete" })).status).toBe(400);
    // An agent's edit brings it back; the person's own edits don't need to.
    expect((await shelf({ key, action: "archive" })).status).toBe(200);
    const { design: d } = await ws.open(key);
    d.apply({ op: "file.icon", icon: "star" }, { kind: "agent", name: "t" });
    expect((await shop())?.shelf).toBe("scratch");
    d.apply({ op: "file.icon", icon: null }, { kind: "agent", name: "t" });
    // A page on another site can't.
    expect(
      (await shelf({ key, action: "archive" }, { origin: "https://evil.example" })).status,
    ).toBe(403);
  } finally {
    server.stop(true);
    await ws.closeAll();
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

test("a design in a git checkout carries its root, branch and project; a worktree's, a detached HEAD's and none", async () => {
  const { gitOf } = await import("./catalog.ts");
  const repo = join(dir, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git/HEAD"), "ref: refs/heads/feat/hover-card\n");
  await design(join(repo, "design/app.design"), "App", { Home: ["Hero"] });
  // Without a remote, the project is the main checkout.
  expect(await gitOf(join(repo, "design/app.design"))).toEqual({
    root: repo,
    worktree: false,
    branch: "feat/hover-card",
    project: repo,
    projectName: "repo",
  });
  await writeFile(
    join(repo, ".git/config"),
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:north-brook/ponzu.git\n',
  );
  const project = { project: "github.com/north-brook/ponzu", projectName: "ponzu" };

  // A worktree's .git is a file naming its own HEAD under the main checkout's .git, which
  // names the shared one: the same project.
  const tree = join(dir, "tree");
  await mkdir(join(repo, ".git/worktrees/tree"), { recursive: true });
  await writeFile(join(repo, ".git/worktrees/tree/HEAD"), "ref: refs/heads/t3/abc\n");
  await writeFile(join(repo, ".git/worktrees/tree/commondir"), "../..\n");
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, ".git"), `gitdir: ${join(repo, ".git/worktrees/tree")}\n`);
  expect(await gitOf(join(tree, "x.design"))).toEqual({
    root: tree,
    worktree: true,
    branch: "t3/abc",
    ...project,
  });

  await writeFile(join(repo, ".git/worktrees/tree/HEAD"), "8f1dcad0123456789abcdef\n");
  expect(await gitOf(join(tree, "x.design"))).toEqual({
    root: tree,
    worktree: true,
    commit: "8f1dcad",
    ...project,
  });

  expect(await gitOf(join(dir, "shop.design"))).toBeNull();

  const catalog = new LocalCatalog({ roots: [repo], spotlight: "roots" });
  const [app] = await catalog.files(new Map());
  expect(app?.git).toEqual({
    root: repo,
    worktree: false,
    branch: "feat/hover-card",
    ...project,
  });
});

test("every worktree of a repository a design is known in is walked", async () => {
  const main = join(dir, "wt-main");
  await mkdir(join(main, ".git/worktrees/feature"), { recursive: true });
  await writeFile(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
  await design(join(main, "design/known.design"), "Known", { Home: ["A"] });
  // A worktree far from the main checkout, with a design only it has.
  const tree = join(dir, "elsewhere/feature");
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, ".git"), `gitdir: ${join(main, ".git/worktrees/feature")}\n`);
  await writeFile(join(main, ".git/worktrees/feature/gitdir"), `${join(tree, ".git")}\n`);
  await writeFile(join(main, ".git/worktrees/feature/commondir"), "../..\n");
  await writeFile(join(main, ".git/worktrees/feature/HEAD"), "ref: refs/heads/feature\n");
  await design(join(tree, ".context/only-here.design"), "Only here", { Home: ["A"] });
  // And one `git worktree add --relative-paths` made, which names its .git file relatively.
  const near = join(dir, "elsewhere/near");
  await mkdir(join(main, ".git/worktrees/near"), { recursive: true });
  await mkdir(near, { recursive: true });
  await writeFile(join(near, ".git"), "gitdir: ../../wt-main/.git/worktrees/near\n");
  await writeFile(join(main, ".git/worktrees/near/gitdir"), "../../../../elsewhere/near/.git\n");
  await writeFile(join(main, ".git/worktrees/near/commondir"), "../..\n");
  await writeFile(join(main, ".git/worktrees/near/HEAD"), "ref: refs/heads/near\n");
  await design(join(near, ".context/relative.design"), "Relative", { Home: ["A"] });
  const catalog = new LocalCatalog({ roots: [join(main, "design")], spotlight: "roots" });
  expect((await catalog.files(new Map())).map((f) => f.name).sort()).toEqual([
    "Known",
    "Only here",
    "Relative",
  ]);
});

test("copies of a design in a repository's checkouts share a fingerprint until one changes", async () => {
  const main = join(dir, "fp-main");
  await mkdir(join(main, ".git/worktrees/agent"), { recursive: true });
  await writeFile(join(main, ".git/HEAD"), "ref: refs/heads/main\n");
  const tree = join(dir, "fp-agent");
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, ".git"), `gitdir: ${join(main, ".git/worktrees/agent")}\n`);
  await writeFile(join(main, ".git/worktrees/agent/gitdir"), `${join(tree, ".git")}\n`);
  await writeFile(join(main, ".git/worktrees/agent/commondir"), "../..\n");
  await writeFile(join(main, ".git/worktrees/agent/HEAD"), "ref: refs/heads/agent\n");
  await design(join(main, "design/app.design"), "App", { Home: ["Hero"] });
  await design(join(tree, "design/app.design"), "App", { Home: ["Hero"] });
  // A fresh catalog each time: one caches a design's last edit for a few seconds.
  const print = async () =>
    (await new LocalCatalog({ roots: [join(main, "design")], spotlight: "roots" }).files(new Map()))
      .filter((f) => f.name === "App")
      .map((f) => f.fingerprint);
  const [a, b] = await print();
  expect(a).toBeString();
  expect(a).toBe(b);
  // An agent draws in the worktree's copy: it's a design of its own again.
  await writeFile(
    join(tree, "design/app.design/pages/home/hero.html"),
    '<section data-artboard data-id="ab_hero" data-name="Hero" style="width:500px;height:300px"></section>',
  );
  const [c, d] = await print();
  expect(c).not.toBe(d);
});

test("a worktree's copy is untouched until its branch changes it, committed or not", async () => {
  const { changedDesignFiles } = await import("./catalog.ts");
  const run = (args: string[], cwd: string) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const main = join(dir, "wt-main");
  await mkdir(main, { recursive: true });
  run(["init", "-q", "-b", "main"], main);
  await design(join(main, "design/app.design"), "App", { Home: ["Hero"] });
  await design(join(main, "design/brand.design"), "Brand", { Logos: ["Mark"] });
  run(["add", "-A"], main);
  run(["commit", "-qm", "designs"], main);
  const tree = join(dir, "wt-agent");
  run(["worktree", "add", "-q", "-b", "agent", tree], main);
  const untouched = async (key: string) => {
    const catalog = new LocalCatalog({ roots: [main, tree], spotlight: "roots" });
    return (await catalog.files(new Map())).find((f) => f.key === key)?.git?.untouched;
  };
  const app = join(tree, "design/app.design");
  expect(await changedDesignFiles(tree)).toEqual([]);
  expect(await untouched(app)).toBe(true);
  // The main checkout's own copy is no worktree's, and says nothing either way.
  expect(await untouched(join(main, "design/app.design"))).toBeUndefined();
  // A drawn preview is no change.
  await mkdir(join(app, ".ponzu"), { recursive: true });
  await writeFile(join(app, ".ponzu/preview.png"), "png");
  expect(await untouched(app)).toBe(true);

  // An agent draws an artboard: a new file, not yet committed.
  const page = join(app, "pages/home/new.html");
  await writeFile(page, '<section data-artboard data-id="ab_new" data-name="New"></section>');
  expect(await untouched(app)).toBe(false);
  expect(await untouched(join(tree, "design/brand.design"))).toBe(true);
  // Committed on the branch, it's still the branch's own.
  run(["add", "-A"], tree);
  run(["commit", "-qm", "new artboard"], tree);
  expect(await changedDesignFiles(tree)).toEqual(["design/app.design/pages/home/new.html"]);
  expect(await untouched(app)).toBe(false);

  // Main moving on after the branch began isn't the branch changing anything.
  await writeFile(join(main, "design/brand.design/tokens.css"), ":root{}");
  run(["add", "-A"], main);
  run(["commit", "-qm", "tokens"], main);
  expect(await untouched(join(tree, "design/brand.design"))).toBe(true);

  // An artboard moved from one design to another changes both.
  const moved = join(dir, "wt-move");
  run(["worktree", "add", "-q", "-b", "move", moved], main);
  run(
    ["mv", "design/brand.design/pages/logos/mark.html", "design/app.design/pages/home/mark.html"],
    moved,
  );
  run(["commit", "-qm", "move"], moved);
  expect((await changedDesignFiles(moved))?.sort()).toEqual([
    "design/app.design/pages/home/mark.html",
    "design/brand.design/pages/logos/mark.html",
  ]);

  // origin's HEAD naming a pruned branch falls back to one that's there.
  run(["update-ref", "refs/remotes/origin/main", "main"], main);
  run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone"], main);
  expect(await changedDesignFiles(tree)).toEqual(["design/app.design/pages/home/new.html"]);
});

test("remotes name a project the same however they're written", async () => {
  const { remoteId } = await import("./catalog.ts");
  for (const url of [
    "git@github.com:north-brook/ponzu.git",
    "https://github.com/north-brook/ponzu",
    "https://GitHub.com/north-brook/ponzu.git/",
    "ssh://git@github.com:22/north-brook/ponzu.git",
  ])
    expect(remoteId(url)).toBe("github.com/north-brook/ponzu");
  expect(remoteId("file:///tmp/x")).toBeNull();
});

test("a checkout's hidden folders are walked once a design in it is known", async () => {
  const repo = join(dir, "hidden-repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await writeFile(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
  await design(join(repo, "design/app.design"), "Seen", { Home: ["Hero"] });
  // Spotlight never indexes these: a .context folder, a worktree under a dot-folder.
  await design(join(repo, ".context/notes.design"), "In context", { Home: ["A"] });
  await design(join(repo, ".claude/worktrees/x/y.design"), "In a worktree", { Home: ["A"] });
  await design(join(repo, "node_modules/pkg/z.design"), "Vendored", { Home: ["A"] });
  const catalog = new LocalCatalog({ roots: [join(repo, "design")], spotlight: "roots" });
  expect((await catalog.files(new Map())).map((f) => f.name).sort()).toEqual([
    "In a worktree",
    "In context",
    "Seen",
  ]);
});

test("archiving, restoring and shelving are remembered; an agent's edit restores", async () => {
  const dbFile = join(dir, "state/shelf.db");
  const key = join(dir, "nested/deep/brand.design");
  const catalog = new LocalCatalog({ roots: [], spotlight: "roots", dbFile, temp: [] });
  catalog.add(key);
  const shelf = async (c: LocalCatalog) =>
    (await c.files(new Map())).find((f) => f.key === key)?.shelf;
  expect(await shelf(catalog)).toBe("recent");
  catalog.archive(key);
  expect(await shelf(catalog)).toBe("archived");
  // Another process on the same database sees it, and its restore wins once it's later.
  const other = new LocalCatalog({ roots: [], spotlight: "roots", dbFile, temp: [] });
  other.add(key);
  expect(await shelf(other)).toBe("archived");
  await new Promise((r) => setTimeout(r, 5));
  other.edited(key);
  expect(await shelf(catalog)).toBe("recent");
  catalog.shelve(key, "scratch");
  expect(await shelf(other)).toBe("scratch");
  catalog.shelve(key, null);
  expect(await shelf(other)).toBe("recent");
  catalog.close();
  other.close();
});

test("a scratch design lists under Scratch until the person keeps it", async () => {
  const key = join(dir, "scratch/probe.design");
  await design(key, "Probe", { Home: ["A"] });
  const meta = JSON.parse(await readFile(join(key, "design.json"), "utf8"));
  await writeFile(join(key, "design.json"), JSON.stringify({ ...meta, scratch: true }));
  const catalog = new LocalCatalog({ roots: [join(dir, "scratch")], spotlight: "roots" });
  const probe = async () => (await catalog.files(new Map())).find((f) => f.key === key);
  expect(await probe()).toMatchObject({ scratch: true, shelf: "scratch" });
  catalog.shelve(key, "recent");
  expect(await probe()).toMatchObject({ scratch: true, shelf: "recent" });
});

test("a design in a temporary folder lists under Scratch until the person keeps it", async () => {
  const key = join(dir, "temp/mock.design");
  await design(key, "Mock", { Home: ["A"] });
  const kept = join(dir, "kept/mock.design");
  await design(kept, "Kept", { Home: ["A"] });
  // Reached through a symlink, as /tmp is /private/tmp.
  await symlink(join(dir, "temp"), join(dir, "temp-link"));
  const catalog = new LocalCatalog({
    roots: [join(dir, "temp"), join(dir, "kept")],
    spotlight: "roots",
    temp: [join(dir, "temp-link")],
  });
  const listed = async (k: string) => (await catalog.files(new Map())).find((f) => f.key === k);
  expect(await listed(key)).toMatchObject({ scratch: false, shelf: "scratch" });
  expect((await listed(kept))?.shelf).toBe("recent");
  catalog.shelve(key, "recent");
  expect((await listed(key))?.shelf).toBe("recent");
  catalog.close();
});

test("a design whose folder is gone drops off, and comes back with its archive state", async () => {
  const dbFile = join(dir, "state/gone.db");
  const key = join(dir, "gone/temp.design");
  await design(key, "Temp", { Home: ["A"] });
  const catalog = new LocalCatalog({ roots: [join(dir, "gone")], spotlight: "roots", dbFile });
  expect((await catalog.files(new Map())).map((f) => f.name)).toContain("Temp");
  catalog.archive(key);
  // The database knows a design by its real path (/var is /private/var).
  const real = await realpath(key);
  await rm(key, { recursive: true });
  expect((await catalog.files(new Map())).map((f) => f.name)).not.toContain("Temp");
  expect(catalog.db.get(real)?.missing_since).toBeNumber();
  await design(key, "Temp", { Home: ["A"] });
  // Found again by the next look, as a re-created worktree is.
  const again = new LocalCatalog({ roots: [join(dir, "gone")], spotlight: "roots", dbFile });
  await again.rescan();
  expect((await again.files(new Map())).find((f) => f.key === key)?.shelf).toBe("archived");
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
    const dbFile = join(root, "state/ponzu.db");
    const first = new LocalCatalog({ roots: [], spotlight: "roots", dbFile });
    first.opened(sample());
    expect(await names(first)).toEqual(["Sample"]);
    expect(await names(new LocalCatalog({ roots: [], spotlight: "roots", dbFile }))).toEqual([]);
    first.opened(sample(), { remember: true });
    // Listed even with nothing scanned: Spotlight skips hidden folders like .t3 worktrees.
    expect(await names(new LocalCatalog({ roots: [], spotlight: "roots", dbFile }))).toEqual([
      "Sample",
    ]);
  });

  test("what an older version kept in catalog.json is read in once, and kept for going back", async () => {
    const stateFile = join(root, "old/catalog.json");
    await mkdir(join(root, "old"), { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify({ granted: ["/Users/x/Desktop"], opened: [sample()] }),
    );
    const dbFile = join(root, "old/ponzu.db");
    const catalog = new LocalCatalog({ roots: [], spotlight: "roots", dbFile, stateFile });
    expect(await names(catalog)).toEqual(["Sample"]);
    expect(catalog.db.grants()).toEqual(["/Users/x/Desktop"]);
    // A grant here keeps the file's, and another server's, in catalog.json.
    const other = new LocalCatalog({ roots: [], spotlight: "roots", dbFile });
    other.db.grant("/Users/x/Downloads");
    catalog.add(join(homedir(), "Documents/new.design"));
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(await readFile(stateFile, "utf8")).granted.sort()).toEqual(
      [join(homedir(), "Documents"), "/Users/x/Desktop", "/Users/x/Downloads"].sort(),
    );
    // Read once: taken out of the file later, it stays.
    await writeFile(stateFile, JSON.stringify({ granted: [] }));
    const again = new LocalCatalog({ roots: [], spotlight: "roots", dbFile, stateFile });
    expect(await names(again)).toEqual(["Sample"]);
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
