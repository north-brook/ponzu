import { expect, test } from "bun:test";
import { FakeRunnerApi } from "./api/fake.ts";
import { MAX_TEXT } from "./api/protocol.ts";
import { ThreadWriter } from "./thread.ts";

test("only the latest payload of each item is sent, items that changed together in one write", async () => {
  const api = new FakeRunnerApi();
  const thread = new ThreadWriter(api, { gapMs: 50 });
  thread.write({ id: "ti_a", kind: "assistant", payload: { text: "H" }, streaming: true });
  await Bun.sleep(5);
  for (const text of ["He", "Hel", "Hell", "Hello"])
    thread.write({ id: "ti_a", kind: "assistant", payload: { text }, streaming: true });
  thread.write({
    id: "ti_w",
    kind: "tool",
    payload: { label: "Reading the repo", steps: 1, artboards: [] },
    streaming: true,
  });
  await thread.flush();
  expect(api.threadWrites.map((w) => w.map((i) => i.id))).toEqual([["ti_a"], ["ti_a", "ti_w"]]);
  expect(api.thread.get("ti_a")?.payload).toEqual({ text: "Hello" });
  thread.close();
});

test("a write that fails is sent again, with whatever came in meanwhile", async () => {
  const api = new FakeRunnerApi();
  const thread = new ThreadWriter(api, { gapMs: 1 });
  api.down = true;
  thread.write({ id: "ti_a", kind: "assistant", payload: { text: "One" }, streaming: true });
  await thread.flush();
  thread.write({ id: "ti_a", kind: "assistant", payload: { text: "One two" }, streaming: false });
  api.down = false;
  await thread.flush();
  expect(api.thread.get("ti_a")).toMatchObject({ payload: { text: "One two" }, streaming: false });
  thread.close();
});

test("nothing more is sent for an item the API has as finished", async () => {
  const api = new FakeRunnerApi();
  const thread = new ThreadWriter(api, { gapMs: 1 });
  thread.write({ id: "ti_a", kind: "notice", payload: { type: "started" }, streaming: false });
  await thread.flush();
  thread.write({ id: "ti_a", kind: "notice", payload: { type: "resumed" }, streaming: false });
  await thread.flush();
  expect(api.threadWrites.length).toBe(1);
  thread.close();
});

test("agent text longer than a thread item holds is clipped", async () => {
  const api = new FakeRunnerApi();
  const thread = new ThreadWriter(api, { gapMs: 1 });
  thread.write({
    id: "ti_a",
    kind: "assistant",
    payload: { text: "x".repeat(MAX_TEXT + 10) },
    streaming: false,
  });
  await thread.flush();
  const text = (api.thread.get("ti_a")!.payload as { text: string }).text;
  expect(text.length).toBe(MAX_TEXT);
  expect(text.endsWith("…")).toBe(true);
  thread.close();
});
