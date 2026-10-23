import { expect, test } from "bun:test";
import type { AgentChange, Catalog, CatalogFile, Doc, Thread } from "@ponzu/core";
import { buildActivity, changeTarget, isNew, title, where } from "./activity";
import { mergeCatalogs, type PhoneFile, projects, shortAgo, whereLine } from "./files";
import { mark, search } from "./search";

const file = (over: Partial<CatalogFile> = {}): CatalogFile => ({
  id: "local:/a/kettle.design",
  key: "/a/kettle.design",
  name: "Kettle",
  machine: "local",
  base: "",
  modified: 1000,
  preview: "/api/preview?file=k",
  pages: [{ id: "pg_1", name: "Brand" }],
  artboards: [{ id: "ab_1", name: "Logo", page: "pg_1", thumb: "/api/thumb?file=k&artboard=ab_1" }],
  ...over,
});
const catalog = (files: CatalogFile[]): Catalog => ({ machines: [], files, agents: [] });
const macs = [
  { id: "mbp", name: "MacBook", kind: "laptop" as const, base: "http://mbp:7777" },
  { id: "spare", name: "spare", kind: "desktop" as const, base: "http://spare:7777" },
];

test("every Mac's designs in one list, newest first, with absolute URLs and dimmed when asleep", () => {
  const merged = mergeCatalogs(
    macs,
    {
      mbp: { catalog: catalog([file({ modified: 10 })]), at: 0 },
      spare: {
        catalog: catalog([
          file({ id: "local:/b/weft.design", key: "/b/weft.design", name: "Weft", modified: 20 }),
        ]),
        at: 0,
      },
    },
    (id) => id === "mbp",
  );
  expect(merged.map((f) => [f.name, f.macName, f.stale])).toEqual([
    ["Weft", "spare", true],
    ["Kettle", "MacBook", false],
  ]);
  expect(merged[1]!.preview).toBe("http://mbp:7777/api/preview?file=k");
  expect(merged[1]!.artboards[0]!.thumb).toBe("http://mbp:7777/api/thumb?file=k&artboard=ab_1");
  expect(merged[1]!.id).toBe("mbp:/a/kettle.design");
});

test("project chips: biggest first, then the designs in no project", () => {
  const files = [
    file({ git: { root: "/r", projectName: "ponzu" } }),
    file({ git: { root: "/r", projectName: "ponzu" } }),
    file({ git: { root: "/s", projectName: "os" } }),
    file(),
  ] as PhoneFile[];
  expect(projects(files)).toEqual([
    { name: "ponzu", count: 2 },
    { name: "os", count: 1 },
    { name: null, count: 1 },
  ]);
});

test("a card's line: the branch, or the folder outside git", () => {
  expect(whereLine(file({ git: { root: "/r", branch: "main" } }) as PhoneFile).branch).toBe("main");
  expect(whereLine(file({ key: "/Users/b/examples/kettle.design" }) as PhoneFile)).toEqual({
    branch: null,
    folder: "examples",
  });
});

test("times read as the desktop's cards do", () => {
  const now = Date.UTC(2026, 9, 22, 12);
  expect(shortAgo(now - 20_000, now)).toBe("now");
  expect(shortAgo(now - 4 * 60_000, now)).toBe("4m");
  expect(shortAgo(now - 2 * 3_600_000, now)).toBe("2h");
  expect(shortAgo(now - 86_400_000, now)).toBe("1d");
  expect(shortAgo(Date.UTC(2026, 9, 14, 12), now)).toBe("Oct 14");
});

test("search finds files and frames by every word, and marks what matched", () => {
  const files = mergeCatalogs(
    macs.slice(0, 1),
    {
      mbp: {
        catalog: catalog([
          file({ name: "Ponzu brand", key: "/p.design", id: "local:/p.design" }),
          file({ pages: [{ id: "pg_1", name: "Brand" }] }),
        ]),
        at: 0,
      },
    },
    () => true,
  );
  const r = search(files, "brand");
  expect(r.files.map((h) => h.file.name)).toEqual(["Ponzu brand"]);
  expect(r.frames.map((h) => `${h.artboard.name} · ${h.pageName} · ${h.file.name}`).sort()).toEqual(
    ["Logo · Brand · Kettle", "Logo · Brand · Ponzu brand"],
  );
  expect(search(files, "logo kettle").frames).toHaveLength(1);
  expect(search(files, "  ").files).toHaveLength(0);
  expect(mark("Ponzu brand", ["brand"])).toEqual([
    { text: "Ponzu ", hit: false },
    { text: "brand", hit: true },
  ]);
  expect(mark("Café", ["cafe"])).toEqual([{ text: "Café", hit: true }]);
});

test("activity: an agent's reply after yours, your comments it resolved, its work in your designs", () => {
  const msg = (kind: "user" | "agent", text: string, createdAt: number) => ({
    id: `m_${createdAt}`,
    author: { kind, name: kind === "agent" ? "Claude Code" : "You" },
    text,
    createdAt,
  });
  const thread = (id: string, status: Thread["status"], messages: Thread["messages"]): Thread => ({
    id,
    artboardId: "ab_1",
    x: 0,
    y: 0,
    status,
    createdAt: 1,
    updatedAt: 500,
    messages,
  });
  const doc: Pick<Doc, "threads" | "pages"> = {
    pages: [{ id: "pg_1", name: "App", artboards: [{ id: "ab_1", name: "6 Money" } as never] }],
    threads: [
      thread("th_a", "open", [msg("user", "Bigger", 100), msg("agent", "Done: 56px", 200)]),
      thread("th_b", "open", [msg("agent", "Earlier", 50), msg("user", "Thanks", 100)]),
      thread("th_c", "resolved", [msg("user", "Fix it", 10), msg("agent", "Fixed", 20)]),
    ],
  };
  const [kettle] = mergeCatalogs(
    macs.slice(0, 1),
    {
      mbp: {
        catalog: catalog([
          file({
            modified: 5000,
            agents: [{ id: "s1", name: "Claude Code", client: "claude", activity: "working" }],
          }),
        ]),
        at: 0,
      },
    },
    () => true,
  );
  const input = {
    files: [kettle!],
    docs: { "mbp:/a/kettle.design": doc },
    seen: { "mbp:/a/kettle.design": 1000 },
    activitySeenAt: 150,
  };
  const items = buildActivity(input);
  expect(items.map((i) => [i.kind, title(i)])).toEqual([
    ["work", "Claude is working"],
    ["resolved", "Claude resolved your comment"],
    ["reply", "Claude replied to you"],
  ]);
  const reply = items.find((i) => i.kind === "reply")!;
  expect(reply.kind === "reply" && reply.board?.name).toBe("6 Money");
  // The reply came after Activity was last opened; the resolve (at 500) too; the work is unseen.
  expect(items.map((i) => isNew(i, input))).toEqual([true, true, true]);
  expect(isNew(reply, { ...input, activitySeenAt: 300 })).toBe(false);
});

test("activity: what agents changed, from each Mac's history", () => {
  const [kettle] = mergeCatalogs(
    macs.slice(0, 1),
    {
      mbp: {
        catalog: catalog([
          file({
            modified: 5000,
            pages: [
              { id: "pg_1", name: "Brand", icon: "palette" },
              { id: "pg_2", name: "App", icon: "phone" },
            ],
            artboards: [
              { id: "ab_1", name: "Logo", page: "pg_1", thumb: "/t1" },
              { id: "ab_2", name: "2 Home", page: "pg_2", thumb: "/t2" },
            ],
          }),
        ]),
        at: 0,
      },
    },
    () => true,
  );
  const change = (over: Partial<AgentChange>): AgentChange => ({
    id: "ch_1",
    file: "/a/kettle.design",
    name: "Kettle",
    start: 3000,
    at: 4000,
    agent: { name: "Claude", client: "claude" },
    artboards: [],
    summary: "",
    kind: "changed",
    ...over,
  });
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    id: i === 0 ? "ab_gone" : `ab_${i + 1}`,
    name: `B${i}`,
    page: "pg_2",
    thumb: `/t${i}`,
  }));
  const input = {
    files: [kettle!],
    changes: {
      mbp: [
        change({ artboards: twelve }),
        change({
          id: "ch_2",
          at: 2000,
          agent: { name: "Codex", client: "openai" },
          kind: "added",
          artboards: [
            { id: "ab_1", name: "Logo", page: "pg_1" },
            { id: "ab_2", name: "2 Home", page: "pg_2" },
            { id: "ab_3", name: "3", page: "pg_2" },
          ],
        }),
        // A design the phone doesn't list.
        change({ id: "ch_3", file: "/elsewhere.design", artboards: twelve }),
      ],
    },
    docs: {},
    seen: { "mbp:/a/kettle.design": 5000 },
    activitySeenAt: 1000,
  };
  const items = buildActivity(input);
  expect(items.map((i) => title(i))).toEqual([
    "Claude changed 12 artboards",
    "Codex added 3 artboards",
  ]);
  const [claude, codex] = items as Extract<(typeof items)[number], { kind: "change" }>[];
  expect(claude!.pages).toEqual([{ name: "App", icon: "phone" }]);
  expect(codex!.pages).toEqual([
    { name: "Brand", icon: "palette" },
    { name: "App", icon: "phone" },
  ]);
  // The where-line: the file, then each page with its own icon.
  expect(where(codex!)).toEqual({ file: "Kettle", places: codex!.pages });
  // It opens on the first changed artboard still in the design.
  expect(changeTarget(claude!)).toBe("ab_2");
  // With a history, a design that changed since you looked isn't a separate item.
  expect(items.some((i) => i.kind === "work")).toBe(false);
  // New since Activity was last opened, even in a design the phone counts as seen.
  expect(isNew(claude!, input)).toBe(true);
  expect(isNew(claude!, { seen: {}, activitySeenAt: 4500 })).toBe(false);
  // A Mac too old to keep a history: the design that changed shows instead.
  const old = buildActivity({
    ...input,
    changes: { mbp: null },
    seen: { "mbp:/a/kettle.design": 10 },
  });
  expect(old.map((i) => i.kind)).toEqual(["work"]);
});
