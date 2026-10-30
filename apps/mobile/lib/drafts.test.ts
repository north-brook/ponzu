import { expect, test } from "bun:test";
import { draftFile, draftKey, getDraft, moveDraft, setDraft } from "./drafts";

test("copies of a design, which share thread ids, keep their own drafts", () => {
  const original = draftFile("studio", "/work/kettle.design");
  const copy = draftFile("studio", "/worktree/kettle.design");
  const otherMac = draftFile("laptop", "/work/kettle.design");
  const pin = { artboardId: "ab_1", x: 4, y: 8 };
  expect(draftKey.reply(original, "th_1")).not.toBe(draftKey.reply(copy, "th_1"));
  expect(draftKey.reply(original, "th_1")).not.toBe(draftKey.reply(otherMac, "th_1"));
  expect(draftKey.comment(original, pin)).not.toBe(draftKey.comment(copy, pin));
  const key = draftKey.reply(original, "th_1");
  setDraft(key, { file: original, thread: "th_1", text: "and the lid" });
  expect(getDraft(draftKey.reply(copy, "th_1"))).toBeUndefined();
  setDraft(key, { file: original, thread: "th_1", text: "" });
  expect(getDraft(key)).toBeUndefined();
});

test("an unsent comment moved to another spot takes its words with it", () => {
  const file = draftFile("studio", "/work/kettle.design");
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
