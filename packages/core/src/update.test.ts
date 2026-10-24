import { expect, test } from "bun:test";
import type { CatalogMachine } from "./catalog.ts";
import { changelogNotes, updatePlan } from "./update.ts";

const mac = (id: string, update?: CatalogMachine["update"]): CatalogMachine => ({
  id,
  name: id === "local" ? "This Mac" : id,
  kind: "desktop",
  ...(update ? { update } : {}),
});

test("nothing to offer until a Mac has a newer Ponzu downloaded", () => {
  expect(updatePlan([])).toBeNull();
  expect(updatePlan([mac("local", { version: "1.43.0" }), mac("air", { version: "1.43.0" })])).toBe(
    null,
  );
});

test("one Mac's download is offered for every Mac behind it", () => {
  const plan = updatePlan([
    mac("local", { version: "1.43.0", ready: { version: "1.44.0", notes: ["Faster."] } }),
    mac("air", { version: "1.43.0" }),
    mac("spare", { version: "1.42.0", ready: { version: "1.44.0", notes: ["Older notes."] } }),
    // `ponzu serve`, or an app from before updates spread: not counted.
    mac("mini"),
  ]);
  expect(plan).toEqual({
    version: "1.44.0",
    notes: ["Faster."],
    macs: ["local", "air", "spare"],
    of: 3,
    installing: false,
  });
});

test("a Mac that already updated still offers it to the rest, with no notes of its own", () => {
  const plan = updatePlan([mac("local", { version: "1.43.0" }), mac("air", { version: "1.44.0" })]);
  expect(plan).toMatchObject({ version: "1.44.0", notes: [], macs: ["local"], of: 2 });
});

test("the newest download wins, and an install under way shows", () => {
  const plan = updatePlan([
    mac("local", { version: "1.43.0", ready: { version: "1.44.0", notes: ["a"] } }),
    mac("air", { version: "1.43.0", ready: { version: "1.45.0", notes: ["b"] }, installing: true }),
  ]);
  expect(plan).toMatchObject({ version: "1.45.0", notes: ["b"], installing: true });
});

test("a changelog's items become sentences, without links", () => {
  const html = `<h2><a href="x">1.43.0</a> (2026-10-24)</h2>
<h3>Features</h3>
<ul>
<li>let agents choose from a much wider set of page and file icons (<a href="https://github.com/north-brook/ponzu/issues/178">#178</a>) (<a href="https://github.com/north-brook/ponzu/commit/86d591d">86d591d</a>)</li>
</ul>
<h3>Bug Fixes</h3>
<ul>
<li><strong>desktop:</strong> open agents&#39; design links from your other macs (<a href="#">#175</a>)</li>
</ul>`;
  expect(changelogNotes(html)).toEqual([
    "Let agents choose from a much wider set of page and file icons.",
    "Open agents' design links from your other macs.",
  ]);
  const md = `### Features

* let agents choose icons ([#178](https://github.com/north-brook/ponzu/issues/178)) ([86d591d](https://github.com/north-brook/ponzu/commit/86d591d))`;
  expect(changelogNotes(md)).toEqual(["Let agents choose icons."]);
});
