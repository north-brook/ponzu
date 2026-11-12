import { expect, test } from "bun:test";
import { queryKeys } from "@ponzu/client/query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { PersistedClient } from "@tanstack/react-query-persist-client";
import { buster, closableStorage, PERSIST_KEY, persistable, phoneKeys } from "./persist";

test("what opens the app offline goes to disk", () => {
  for (const key of [
    queryKeys.me(),
    queryKeys.workspace("ws_1"),
    phoneKeys.canvases("ws_1"),
    phoneKeys.canvasView("cnv_1"),
    queryKeys.pullRequest("cnv_1"),
    queryKeys.claudeDefaults(),
    queryKeys.usage("ws_1"),
    queryKeys.notifications(),
  ]) {
    expect(persistable(key)).toBe(true);
  }
});

test("thread pages, questions and everything not named stay in memory", () => {
  for (const key of [
    queryKeys.threadPage("cnv_1", null, 50),
    queryKeys.question("cnv_1", "q_1"),
    queryKeys.pullRequestFile("cnv_1", "a.ts", "abc"),
    queryKeys.canvasPeople("cnv_1"),
    queryKeys.githubAccounts(),
    queryKeys.claudeAccount(),
    queryKeys.environments("ws_1"),
    queryKeys.workspaces(),
    queryKeys.canvas("cnv_1"),
    ["other", "me"],
    [],
  ]) {
    expect(persistable(key)).toBe(false);
  }
});

test("no key the cache may write to disk holds a token", () => {
  // The keys are ids and names; what a secret looks like never appears in one.
  const keys = [queryKeys.me(), phoneKeys.canvases("ws_1"), phoneKeys.canvasView("cnv_1")];
  for (const key of keys) expect(JSON.stringify(key)).not.toMatch(/token|secret|eyJ|sk-/i);
});

test("a new version or another person starts from nothing", () => {
  expect(buster("1.0.0", "usr_1")).toBe("1.0.0:usr_1");
  expect(buster("1.0.0", "usr_1")).not.toBe(buster("1.0.0", "usr_2"));
  expect(buster("1.0.0", "usr_1")).not.toBe(buster("1.0.1", "usr_1"));
});

test("a save the throttle held back never writes a signed-out person's answers back", async () => {
  const items = new Map<string, string>();
  const memory = {
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => void items.set(key, value),
    removeItem: async (key: string) => void items.delete(key),
  };
  const disk = closableStorage(memory);
  const persister = createAsyncStoragePersister({
    key: PERSIST_KEY,
    storage: disk.storage,
    throttleTime: 20,
  });
  const client = (name: string) =>
    ({
      timestamp: 0,
      buster: "1.0.0:usr_1",
      clientState: { mutations: [], queries: [{ queryKey: ["ponzu", "me"], name }] },
    }) as unknown as PersistedClient;
  // The first save runs at once; the second waits out the throttle.
  await persister.persistClient(client("first"));
  const held = persister.persistClient(client("Maya Lin"));
  // Signing out: shut, then remove the copy on disk.
  disk.close();
  await persister.removeClient();
  await held;
  expect(items.has(PERSIST_KEY)).toBe(false);
  // Reading back and removing still work once shut.
  expect(await disk.storage.getItem(PERSIST_KEY)).toBeNull();
});
