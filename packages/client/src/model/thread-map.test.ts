import { expect, test } from "bun:test";
import type { Person } from "./model.ts";
import { answerLine, branchMoment, shownItems, toThreadItem } from "./thread-map.ts";

/*
 * The thread's live rows as the rail's model, on their own. How they arrive and are answered
 * is tested against Ponzu Cloud in memory, in apps/studio/src/app/thread.test.ts.
 */

const ctx = (people: ReadonlyMap<string, Person>) => ({
  people,
  assetsUrl: "https://assets.test/d/",
  doc: null,
});

test("what the agent did to the pull request is its own line, naming who it acted as, said once", () => {
  const maya: Person = {
    id: "usr_maya",
    name: "Maya Ortiz",
    login: "maya",
    avatarUrl: "https://a/m.png",
  };
  const people = new Map([[maya.id, maya]]);
  const at = "2026-11-11T10:00:00.000Z";
  const notice = (id: string, seq: number, payload: Record<string, unknown>) =>
    ({ id, seq, at, streaming: false, kind: "notice", payload }) as never;
  const url = "https://github.com/north-brook/site/pull/12";
  const as = { id: "usr_maya", name: "Maya Ortiz", login: "maya" };
  const items = [
    notice("ti_pr-12-opened", 1, {
      type: "pull_request",
      number: 12,
      url,
      title: "Pricing",
      state: "draft",
    }),
    notice("ti_pra-1", 2, {
      type: "pull_request_agent",
      action: "opened",
      number: 12,
      url,
      title: "Pricing",
      as,
    }),
    notice("ti_pra-2", 3, {
      type: "pull_request_agent",
      action: "ready",
      number: 12,
      url,
      title: "Pricing",
      as,
    }),
    notice("ti_pr-12-merged", 4, {
      type: "pull_request",
      number: 12,
      url,
      title: "Pricing",
      state: "merged",
    }),
  ];
  // The agent opened it, so its line says so; the merge was someone's on GitHub, so GitHub's line stays.
  expect(shownItems(items, new Set()).map((i) => i.id)).toEqual([
    "ti_pra-1",
    "ti_pra-2",
    "ti_pr-12-merged",
  ]);
  expect(toThreadItem(items[1]!, ctx(people)).payload).toEqual({
    type: "pull_request_agent",
    action: "opened",
    number: 12,
    url,
    title: "Pricing",
    as: maya,
  });
  // A line that moves the branch, like any pull request notice.
  expect(branchMoment(items.slice(1, 3))).toBe(3);
});

test("a closed question's line says what was picked: the labels, or yes or no", () => {
  expect(
    answerLine({ status: "answered", answer: { answers: { "Which accent?": "Royal blue" } } }),
  ).toBe("Royal blue");
  expect(answerLine({ status: "answered", answer: { approved: false } })).toBe("No");
  expect(answerLine({ status: "cancelled", answer: null })).toBeNull();
  expect(answerLine(undefined)).toBeNull();
});
