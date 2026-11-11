import { expect, test } from "bun:test";
import { checkMessages, describedAfterLastCommit, idsOf, parseDesignAddress } from "./checks.ts";
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
