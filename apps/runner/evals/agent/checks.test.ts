import { expect, test } from "bun:test";
import { type FactInputs, factsText, pushAndNotices } from "./agent.eval.ts";
import {
  checkMessages,
  describedAfterLastCommit,
  idsOf,
  parseDesignAddress,
  pullRequestAsAsked,
} from "./checks.ts";
import { pricingDoc } from "./seeds.ts";

// The agent suite's exact checks, without a model: what they pass and fail is code's to decide.

const doc = pricingDoc();
const [home, mobile] = doc.pages;
const hero = home!.artboards[0]!;
const design = "des_eval";
const link = (q: string) => `https://ponzu.design/designs/${design}${q}`;
const check = (...messages: string[]) =>
  checkMessages(messages, { designId: design, docAfter: doc, docBefore: doc });

test("a link to a board or page of this design passes; one to a board that is gone fails", () => {
  expect(
    check(
      `See [${hero.name}](${link(`?artboard=${hero.id}`)}) and [Mobile](${link(`?page=${mobile!.id}`)}).`,
    ).results,
  ).toEqual({
    links: true,
    no_bare_address: true,
    no_ids: true,
  });
  const gone = check(`See [Old](${link("?artboard=ab_gone000")}).`);
  expect(gone.results.links).toBe(false);
  expect(gone.problems).toEqual([`a board not in the design: ${link("?artboard=ab_gone000")}`]);
});

test("another design's address, or one dressed up as ours, fails", () => {
  expect(
    check(`[x](https://ponzu.design/designs/des_other?artboard=${hero.id})`).results.links,
  ).toBe(false);
  expect(
    check(`[x](https://ponzu.design/designs/${design}?artboard=${hero.id}&artboard=${hero.id})`)
      .results.links,
  ).toBe(false);
  // Not our host at all: not one of our links, so not checked as one.
  expect(check(`[x](https://ponzu.design.evil.test/designs/${design})`).links).toHaveLength(0);
});

test("an address pasted as text, or a bare one, fails; one only as a link's address passes", () => {
  expect(check(`Open ${link(`?artboard=${hero.id}`)} on your phone.`).results.no_bare_address).toBe(
    false,
  );
  expect(check(`[${link("")}](${link("")})`).results.no_bare_address).toBe(false);
  expect(check(`[Pricing hero](${link(`?artboard=${hero.id}`)})`).results.no_bare_address).toBe(
    true,
  );
});

test("an id people would read fails, in text or in code; in a link's address it does not", () => {
  expect(check(`I changed ${hero.id}.`).results.no_ids).toBe(false);
  expect(check(`I changed \`${hero.id}\`.`).results.no_ids).toBe(false);
  expect(check(`I changed [the hero](${link(`?artboard=${hero.id}`)}).`).results.no_ids).toBe(true);
  expect(idsOf(doc).has(mobile!.id)).toBe(true);
});

test("our address parser reads only the exact form", () => {
  expect(parseDesignAddress(link(`?page=${mobile!.id}`))).toEqual({
    designId: design,
    page: mobile!.id,
  });
  for (const href of [
    `http://ponzu.design/designs/${design}`,
    `https://ponzu.design:8443/designs/${design}`,
    `https://ada@ponzu.design/designs/${design}`,
    `https://ponzu.design/d/${design}`,
    `https://ponzu.design/designs/${design}?artboard=a%20b`,
  ]) {
    expect(parseDesignAddress(href)).toBeNull();
  }
});

test("describe_pull_request after the last commit, by the second", () => {
  expect(describedAfterLastCommit([], [])).toBeNull();
  expect(describedAfterLastCommit([{ at: 100 }, { at: 200 }], [{ at: 150_000 }])).toBe(false);
  expect(describedAfterLastCommit([{ at: 100 }, { at: 200 }], [{ at: 200_400 }])).toBe(true);
});

const BASE_FACTS: FactInputs = {
  made: [],
  changed: [],
  deleted: [],
  pagesMade: [],
  tokensChanged: false,
  repo: true,
  commits: [],
  pushed: 0,
  refused: null,
  summaries: 0,
  ponzuPushFailed: false,
  notices: [],
  questions: 0,
  ended: "end_turn",
};

test("only the runner's own push failure is told to the judge as one; other notices are their own facts", () => {
  const other = "export_failed: the screenshot could not be made";
  expect(pushAndNotices({ branch: { unpushed: 0, error: null }, errors: [other] })).toEqual({
    ponzuPushFailed: false,
    notices: [other],
  });
  expect(pushAndNotices({ branch: null, errors: ["push_failed: remote rejected", other] })).toEqual(
    { ponzuPushFailed: true, notices: [other] },
  );
  expect(pushAndNotices({ branch: { unpushed: 1, error: "rejected" }, errors: [] })).toEqual({
    ponzuPushFailed: true,
    notices: [],
  });
  const facts = factsText({ ...BASE_FACTS, notices: [other] });
  expect(facts).toContain(`Ponzu showed an error notice in the thread: ${other}`);
  expect(facts).not.toContain("Ponzu's own push");
});

test("the pull request moves only as asked: opened when ready, merged only when told", () => {
  const open = { action: "open", outcome: "done" };
  const merge = { action: "merge", outcome: "done" };
  expect(pullRequestAsAsked([open], { opens: true, merges: false })).toEqual({
    opened: true,
    merged: true,
    problems: [],
  });
  // A merge nobody asked for fails, even one the API refused: the agent tried.
  const refused = pullRequestAsAsked([{ action: "merge", outcome: "turn_not_from_person" }], {
    merges: false,
  });
  expect(refused.merged).toBe(false);
  expect(refused.problems[0]).toContain("tried to land it, though nobody asked");
  expect(
    pullRequestAsAsked([{ action: "auto_merge", outcome: "done" }], { merges: false }).merged,
  ).toBe(false);
  // Told to ship it: only a merge GitHub took passes.
  expect(pullRequestAsAsked([merge], { merges: true }).merged).toBe(true);
  expect(
    pullRequestAsAsked([{ action: "merge", outcome: "review_required" }], { merges: true }).merged,
  ).toBe(false);
  expect(pullRequestAsAsked([], { opens: true, merges: false }).problems).toEqual([
    "did not open the pull request",
  ]);
  expect(pullRequestAsAsked([merge], undefined)).toEqual({
    opened: null,
    merged: null,
    problems: [],
  });
});

test("the judge hears what happened to the pull request, when the turn says", () => {
  const before = factsText(BASE_FACTS);
  // A row recorded before the agent drove its pull request reads as it did.
  expect(before).toContain("No pull request is open.");
  const facts = factsText({
    ...BASE_FACTS,
    summaries: 1,
    pullRequestStart: { number: 4, state: "open" },
    pullRequestCalls: [
      { action: "read", outcome: "done" },
      { action: "merge", outcome: "done" },
    ],
  });
  expect(facts).toContain("When the turn began, pull request #4 was open.");
  expect(facts).toContain("The agent's pull request tools: merge (done).");
  expect(facts).not.toContain("No pull request is open.");
  expect(facts).not.toContain("saved for the one the person opens");
});
