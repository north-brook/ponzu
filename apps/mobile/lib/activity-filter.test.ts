import { expect, test } from "bun:test";
import {
  type ActivityItem,
  activityEmpty,
  DEFAULT_FILTER,
  filterActivity,
  filtersOn,
} from "./activity";
import type { PhoneFile } from "./files";

const file = { name: "Kettle", mac: "m", key: "/k.design" } as PhoneFile;
const item = (kind: ActivityItem["kind"], id: string, at: number, extra = {}): ActivityItem =>
  ({ kind, id, at, file, ...extra }) as ActivityItem;

const change = item("change", "c", 50);
const reply = item("reply", "r", 40);
const resolved = item("resolved", "s", 30);
const oldChange = item("change", "c0", 10);
const working = item("work", "w", 5, { agent: { name: "Claude", activity: "working" } });

test("New, the default, is what's new, newest first", () => {
  const list = filterActivity({ fresh: [reply, change], old: [oldChange] }, DEFAULT_FILTER);
  expect(list.map((i) => i.id)).toEqual(["c", "r"]);
});

test("Everything adds what's been seen, in one list", () => {
  const list = filterActivity(
    { fresh: [change], old: [oldChange, resolved] },
    { show: "all", kind: "all" },
  );
  expect(list.map((i) => i.id)).toEqual(["c", "s", "c0"]);
});

test("an agent at work now always shows under New, and leads", () => {
  const list = filterActivity({ fresh: [change], old: [working] }, DEFAULT_FILTER);
  expect(list.map((i) => i.id)).toEqual(["w", "c"]);
});

test("a kind keeps its own items; work counts as a change", () => {
  const items = { fresh: [change, reply, resolved, working], old: [] };
  expect(filterActivity(items, { show: "new", kind: "changes" }).map((i) => i.id)).toEqual([
    "w",
    "c",
  ]);
  expect(filterActivity(items, { show: "new", kind: "replies" }).map((i) => i.id)).toEqual(["r"]);
  expect(filterActivity(items, { show: "new", kind: "resolved" }).map((i) => i.id)).toEqual(["s"]);
});

test("the button's badge counts choices off the default", () => {
  expect(filtersOn(DEFAULT_FILTER)).toBe(0);
  expect(filtersOn({ show: "all", kind: "all" })).toBe(1);
  expect(filtersOn({ show: "new", kind: "replies" })).toBe(1);
  expect(filtersOn({ show: "all", kind: "resolved" })).toBe(2);
});

test("empty: nothing ever, caught up, or none of a kind", () => {
  expect(activityEmpty({ fresh: [], old: [] }, DEFAULT_FILTER)).toBe("never");
  expect(activityEmpty({ fresh: [], old: [oldChange] }, DEFAULT_FILTER)).toBe("caughtUp");
  expect(activityEmpty({ fresh: [change], old: [] }, { show: "new", kind: "replies" })).toBe(
    "noKind",
  );
  expect(activityEmpty({ fresh: [], old: [oldChange] }, { show: "all", kind: "replies" })).toBe(
    "noKind",
  );
  expect(activityEmpty({ fresh: [change], old: [] }, DEFAULT_FILTER)).toBeNull();
});
