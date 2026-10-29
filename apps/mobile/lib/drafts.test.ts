import { expect, test } from "bun:test";
import { draftFile, draftKey, getDraft, setDraft } from "./drafts";

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
