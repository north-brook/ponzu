import { expect, test } from "bun:test";
import type { CatalogMachine, UpdatePlan } from "@ponzu/core";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBody } from "./update.tsx";

const plan = (p: Partial<UpdatePlan> = {}): UpdatePlan => ({
  version: "1.44.0",
  notes: ["Comments sync as you type."],
  since: "1.43.0",
  macs: ["local"],
  of: 1,
  installing: false,
  ...p,
});

const mac = (id: string, update: CatalogMachine["update"]): CatalogMachine => ({
  id,
  name: id === "local" ? "This Mac" : id,
  kind: "desktop",
  update,
});

test("the release notes, Later and Restart", () => {
  const html = renderToStaticMarkup(<UpdateBody plan={plan()} updating={false} />);
  expect(html).toContain("Ponzu 1.44.0");
  expect(html).toContain("<li>Comments sync as you type.</li>");
  expect(html).toMatch(/<\/svg>Restart<\/button>/);
  expect(html).toContain(">Later</button>");
});

test("counts the Macs only when there's more than this one", () => {
  expect(renderToStaticMarkup(<UpdateBody plan={plan()} updating={false} />)).not.toContain(
    "your Macs",
  );
  const all = plan({ macs: ["local", "air", "spare", "mini"], of: 4 });
  const allHtml = renderToStaticMarkup(<UpdateBody plan={all} updating={false} />);
  expect(allHtml).toContain('aria-label="On all 4 of your Macs"');
  expect(allHtml).toMatch(/<\/svg>4<\/button>/);
  const some = plan({ macs: ["local", "air"], of: 3 });
  const someHtml = renderToStaticMarkup(<UpdateBody plan={some} updating={false} />);
  expect(someHtml).toContain('aria-label="On 2 of your Macs"');
  expect(someHtml).toMatch(/<\/svg>2<\/button>/);
});

test("the Mac count's name lists each Mac and when it updates", () => {
  const machines = [
    mac("local", { version: "1.43.0" }),
    mac("air", { version: "1.43.0", waitsFor: "openai" }),
  ];
  const html = renderToStaticMarkup(
    <UpdateBody
      plan={plan({ macs: ["local", "air"], of: 2 })}
      machines={machines}
      updating={false}
    />,
  );
  expect(html).toContain(
    'aria-label="On all 2 of your Macs: This Mac, 1.43.0, restarts last; air, 1.43.0, after Codex finishes"',
  );
});

test("while it installs, it says what happens next", () => {
  const html = renderToStaticMarkup(<UpdateBody plan={plan()} updating />);
  expect(html).toContain("Updating to 1.44.0");
  expect(html).toContain("Agents reconnect on their own.");
  expect(html).not.toContain("<button");
});

test("while an agent works here, the restart says it waits for it", () => {
  const machines = [mac("local", { version: "1.43.0", installing: true, waitsFor: "claude" })];
  const html = renderToStaticMarkup(<UpdateBody plan={plan()} machines={machines} updating />);
  expect(html).toContain("Ponzu restarts once Claude finishes");
});
