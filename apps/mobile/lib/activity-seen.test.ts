import { expect, test } from "bun:test";
import {
  type ActivityItem,
  isUnseen,
  markSeenItems,
  OLD_LIMIT,
  pruneSeenItems,
  SEEN_KEEP_MS,
  splitActivity,
  wasSeen,
  whileInFront,
} from "./activity";
import type { PhoneFile } from "./files";

const file = { name: "Kettle", mac: "m", key: "/k.design" } as PhoneFile;
const item = (kind: ActivityItem["kind"], id: string, at: number): ActivityItem =>
  ({ kind, id, at, file }) as ActivityItem;
const a = item("change", "a", 100);
const b = item("reply", "b", 200);
const c = item("change", "c", 300);

test("marking an item seen covers it as it stands", () => {
  const seen = markSeenItems({}, [a, b]);
  expect(wasSeen(seen, a)).toBe(true);
  expect(wasSeen(seen, c)).toBe(false);
  // Marking again changes nothing (the same set comes back).
  expect(markSeenItems(seen, [a])).toBe(seen);
});

test("an entry that grows after it was seen is new again", () => {
  const seen = markSeenItems({}, [a]);
  expect(wasSeen(seen, { id: "a", at: 150 })).toBe(false);
});

test("New and the bell's count: new by the floor, less what's been seen since", () => {
  const input = { seen: {}, activitySeenAt: 50 };
  const items = [a, b, c];
  const seen = markSeenItems({}, [b]);
  const unseen = items.filter((i) => isUnseen(i, input, seen));
  expect(unseen.map((i) => i.id)).toEqual(["a", "c"]);
  // Seeing one more drops the count by one.
  const more = markSeenItems(seen, [c]);
  expect(items.filter((i) => isUnseen(i, input, more)).length).toBe(1);
});

test("migrating: with no marks yet, the old floor still decides, so nothing old reads new", () => {
  // Before item marks, Activity kept only when it was last left (activitySeenAt).
  const input = { seen: {}, activitySeenAt: 250 };
  expect([a, b, c].filter((i) => isUnseen(i, input, {})).map((i) => i.id)).toEqual(["c"]);
});

test("pruning drops marks the floor covers, and old ones a week on", () => {
  const now = 10 * SEEN_KEEP_MS;
  const seen = { a: 100, b: 200, c: now - 1000 };
  // The floor (when Activity was last left) covers a and b.
  expect(pruneSeenItems(seen, 250, 100, now)).toEqual({ c: now - 1000 });
  // Older than the oldest item Activity could show, and more than a week old: gone.
  expect(pruneSeenItems({ x: 1000, y: now - 10 }, 0, 5000, now)).toEqual({ y: now - 10 });
  // Nothing to drop: the same set.
  const keep = { c: now };
  expect(pruneSeenItems(keep, 0, null, now)).toBe(keep);
});

test("while in front, a row just seen keeps its place; anything unseen since joins", () => {
  // At the front: a and b unseen.
  const snapshot = new Set(["a", "b"]);
  // Then a is seen (it moves to old) and c arrives unseen.
  const now = whileInFront(snapshot, { fresh: [b, c], old: [a] });
  expect(now.fresh.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  expect(now.old).toEqual([]);
});

test("coming back to the front shows only what's unseen then", () => {
  // Rebuilt at the front: a was seen last time, so only b.
  const snapshot = new Set(["b"]);
  const now = whileInFront(snapshot, { fresh: [b], old: [a] });
  expect(now.fresh.map((i) => i.id)).toEqual(["b"]);
  expect(now.old.map((i) => i.id)).toEqual(["a"]);
});

test("the seen part is cut to its limit, but never a row this visit still shows", () => {
  // OLD_LIMIT + 5 seen items, newest first, and none unseen.
  const many = Array.from({ length: OLD_LIMIT + 5 }, (_, n) => item("change", `s${n}`, 1000 - n));
  const plain = splitActivity(many, () => false);
  expect(plain.old).toHaveLength(OLD_LIMIT);
  // The visit's snapshot holds the oldest one (seen during this visit): it stays.
  const oldest = many[many.length - 1]!.id;
  const kept = splitActivity(many, () => false, new Set([oldest]));
  expect(kept.old).toHaveLength(OLD_LIMIT + 1);
  expect(kept.old.some((i) => i.id === oldest)).toBe(true);
  // Unseen items are New, never cut.
  expect(splitActivity(many, (i) => i.id === "s0").fresh.map((i) => i.id)).toEqual(["s0"]);
});
