import { expect, test } from "bun:test";
import type { Catalog, CatalogFile } from "@ponzu/core";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { agentEdited, keys, persistable, shelfMutation, writeCatalogMessage } from "./mac-queries";

const file = (key: string, modified: number, over: Partial<CatalogFile> = {}): CatalogFile => ({
  id: `local:${key}`,
  key,
  name: key
    .split("/")
    .pop()!
    .replace(/\.design$/, ""),
  machine: "local",
  base: "",
  modified,
  preview: null,
  pages: [],
  artboards: [],
  ...over,
});
const catalog = (files: CatalogFile[]): Catalog => ({ machines: [], files, agents: [] });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

test("the stream's snapshot and patches write the catalog query, newest first", () => {
  const qc = client();
  writeCatalogMessage(qc, "mbp", {
    t: "snapshot",
    catalog: catalog([file("/a/kettle.design", 2), file("/a/halon.design", 1)]),
  });
  expect(qc.getQueryData<Catalog>(keys.catalog("mbp"))!.files.map((f) => f.name)).toEqual([
    "kettle",
    "halon",
  ]);

  writeCatalogMessage(qc, "mbp", {
    t: "patch",
    patch: { put: [file("/a/halon.design", 5)], drop: ["local:/a/kettle.design"] },
  });
  writeCatalogMessage(qc, "mbp", {
    t: "patch",
    patch: { put: [file("/a/weft.design", 3)] },
  });
  expect(qc.getQueryData<Catalog>(keys.catalog("mbp"))!.files.map((f) => f.name)).toEqual([
    "halon",
    "weft",
  ]);
  // Another Mac's catalog is its own query.
  expect(qc.getQueryData(keys.catalog("spare"))).toBeUndefined();
});

test("a patch before any snapshot starts from empty, and a ping changes nothing", () => {
  const qc = client();
  writeCatalogMessage(qc, "mbp", { t: "patch", patch: { put: [file("/a/kettle.design", 1)] } });
  const before = qc.getQueryState(keys.catalog("mbp"))!;
  expect(before.data).toMatchObject({ files: [{ name: "kettle" }] });
  writeCatalogMessage(qc, "mbp", { t: "ping" });
  expect(qc.getQueryState(keys.catalog("mbp"))!.dataUpdatedAt).toBe(before.dataUpdatedAt);
});

test("only each Mac's info and catalog go to disk", () => {
  const ok = { status: "success" } as const;
  expect(persistable({ queryKey: ["mac", "mbp", "catalog"], state: ok } as never)).toBe(true);
  expect(persistable({ queryKey: ["mac", "mbp", "info"], state: ok } as never)).toBe(true);
  expect(persistable({ queryKey: ["mac", "mbp", "activity"], state: ok } as never)).toBe(true);
  expect(persistable({ queryKey: ["mac", "mbp", "macs"], state: ok } as never)).toBe(false);
  expect(persistable({ queryKey: ["nearby", "x", "info"], state: ok } as never)).toBe(false);
  expect(
    persistable({ queryKey: ["mac", "mbp", "catalog"], state: { status: "error" } } as never),
  ).toBe(false);
});

const shelfOf = (qc: QueryClient, key: string) =>
  qc.getQueryData<Catalog>(keys.catalog("mbp"))!.files.find((f) => f.key === key)!.shelf;

test("archiving moves the card at once and keeps it there when the Mac agrees", async () => {
  const qc = client();
  qc.setQueryData(keys.catalog("mbp"), catalog([file("/a/kettle.design", 1)]));
  const at = qc.getQueryState(keys.catalog("mbp"))!.dataUpdatedAt;
  let release!: () => void;
  const posted = new Promise<void>((r) => {
    release = r;
  });
  const m = new MutationObserver(
    qc,
    shelfMutation(qc, () => posted),
  );
  const done = m.mutate({ mac: "mbp", key: "/a/kettle.design", action: "archive" });
  await Bun.sleep(0);
  expect(shelfOf(qc, "/a/kettle.design")).toBe("archived");
  // "As they were at …" still reads when the Mac last sent it.
  expect(qc.getQueryState(keys.catalog("mbp"))!.dataUpdatedAt).toBe(at);
  release();
  await done;
  expect(shelfOf(qc, "/a/kettle.design")).toBe("archived");
});

test("a shelf change the Mac refuses goes back, and a patch meanwhile stands", async () => {
  const qc = client();
  qc.setQueryData(
    keys.catalog("mbp"),
    catalog([file("/a/kettle.design", 2, { shelf: "scratch" }), file("/a/halon.design", 1)]),
  );
  let fail!: (err: Error) => void;
  const posted = new Promise<void>((_, reject) => {
    fail = reject;
  });
  const m = new MutationObserver(
    qc,
    shelfMutation(qc, () => posted),
  );
  const done = m.mutate({ mac: "mbp", key: "/a/kettle.design", action: "recent" }).catch(() => {});
  await Bun.sleep(0);
  expect(shelfOf(qc, "/a/kettle.design")).toBe("recent");
  // The stream says halon changed while the request is out.
  writeCatalogMessage(qc, "mbp", {
    t: "patch",
    patch: { put: [file("/a/halon.design", 9, { name: "Halon 2" })] },
  });
  fail(new Error("409"));
  await done;
  expect(shelfOf(qc, "/a/kettle.design")).toBe("scratch");
  expect(qc.getQueryData<Catalog>(keys.catalog("mbp"))!.files[0]!.name).toBe("Halon 2");
  expect(m.getCurrentResult().status).toBe("error");
});

test("an archive the Mac refuses puts a Recent design back with no shelf", async () => {
  const qc = client();
  qc.setQueryData(keys.catalog("mbp"), catalog([file("/a/kettle.design", 1)]));
  const m = new MutationObserver(
    qc,
    shelfMutation(qc, () => Promise.reject(new Error("offline"))),
  );
  await m.mutate({ mac: "mbp", key: "/a/kettle.design", action: "archive" }).catch(() => {});
  expect(shelfOf(qc, "/a/kettle.design")).toBeUndefined();
});

test("a patch with an agent's newer edit asks for activity again; the person's own doesn't", () => {
  const before = catalog([file("/a/kettle.design", 10)]);
  const agent = [{ id: "s1", name: "Claude", client: "claude", activity: "working" as const }];
  const put = (f: CatalogFile) => ({ t: "patch" as const, patch: { put: [f] } });
  expect(agentEdited(before, put(file("/a/kettle.design", 20, { agents: agent })))).toBe(true);
  expect(agentEdited(before, put(file("/a/kettle.design", 20)))).toBe(false);
  // The agent's still there, but nothing new was written.
  expect(agentEdited(before, put(file("/a/kettle.design", 10, { agents: agent })))).toBe(false);
  expect(agentEdited(before, { t: "snapshot", catalog: before })).toBe(false);
});
