import { expect, test } from "bun:test";
import { draftKey, getDraft, moveDraft, setDraft, subscribeDrafts } from "./drafts";

test("canvases keep their own drafts, whatever their thread ids", () => {
  const original = "cnv_kettle";
  const copy = "cnv_kettle_copy";
  const pin = { artboardId: "ab_1", x: 4, y: 8 };
  expect(draftKey.reply(original, "th_1")).not.toBe(draftKey.reply(copy, "th_1"));
  expect(draftKey.comment(original, pin)).not.toBe(draftKey.comment(copy, pin));
  const key = draftKey.reply(original, "th_1");
  setDraft(key, { file: original, thread: "th_1", text: "and the lid" });
  expect(getDraft(draftKey.reply(copy, "th_1"))).toBeUndefined();
  setDraft(key, { file: original, thread: "th_1", text: "" });
  expect(getDraft(key)).toBeUndefined();
});

test("an unsent comment moved to another spot takes its words with it", () => {
  const file = "cnv_kettle";
  const from = { pageId: "pg_1", artboardId: "ab_1", x: 4, y: 8 };
  const to = { pageId: "pg_1", artboardId: "ab_2", nodeId: "n_lid", x: 30, y: 12 };
  const fromKey = draftKey.comment(file, from);
  const toKey = draftKey.comment(file, to);
  setDraft(fromKey, { file, pin: from, text: "tighter gap under the title" });
  moveDraft(fromKey, toKey, to);
  expect(getDraft(fromKey)).toBeUndefined();
  expect(getDraft(toKey)).toEqual({ file, pin: to, text: "tighter gap under the title" });
  // Put down where it was, on another layer: the same key, the new layer.
  const relayered = { ...to, nodeId: "n_spout" };
  moveDraft(toKey, toKey, relayered);
  expect(getDraft(toKey)?.pin).toEqual(relayered);
  // Nothing written there, nothing to move.
  moveDraft(fromKey, draftKey.comment(file, from), from);
  expect(getDraft(fromKey)).toBeUndefined();
  setDraft(toKey, { file, pin: to, text: "" });
});

test("listeners hear a draft arrive, go or move, never its words change", () => {
  const file = "cnv_kettle";
  const pin = { pageId: "pg_1", artboardId: "ab_1", x: 4, y: 8 };
  const key = draftKey.comment(file, pin);
  let heard = 0;
  const stop = subscribeDrafts(() => heard++);
  setDraft(key, { file, pin, text: "t" });
  expect(heard).toBe(1);
  // Typing on: the words are there to read, and nobody is told.
  setDraft(key, { file, pin, text: "ti" });
  setDraft(key, { file, pin, text: "tighter" });
  expect(heard).toBe(1);
  expect(getDraft(key)?.text).toBe("tighter");
  // Nothing worth a pin any more, then something again.
  setDraft(key, { file, pin, text: " " });
  expect(heard).toBe(2);
  setDraft(key, { file, pin, text: " a" });
  expect(heard).toBe(3);
  // Moved.
  setDraft(key, { file, pin: { ...pin, x: 5 }, text: " a" });
  expect(heard).toBe(4);
  // Gone, and nothing more to forget.
  setDraft(key, { file, pin, text: "" });
  expect(heard).toBe(5);
  setDraft(key, { file, pin, text: "" });
  expect(heard).toBe(5);
  stop();
});
