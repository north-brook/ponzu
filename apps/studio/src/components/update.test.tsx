import { expect, test } from "bun:test";
import type { UpdatePlan } from "@ponzu/core";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBody } from "./update.tsx";

const plan = (p: Partial<UpdatePlan> = {}): UpdatePlan => ({
  version: "1.44.0",
  notes: ["Comments sync as you type."],
  macs: ["local"],
  of: 1,
  installing: false,
  ...p,
});

test("what's new, and one Update", () => {
  const html = renderToStaticMarkup(<UpdateBody plan={plan()} updating={false} />);
  expect(html).toContain("Ponzu 1.44.0");
  expect(html).toContain("<li>Comments sync as you type.</li>");
  expect(html).toContain(">Update</button>");
  expect(html).toContain(">Later</button>");
});

test("counts the Macs only when there's more than this one", () => {
  expect(renderToStaticMarkup(<UpdateBody plan={plan()} updating={false} />)).not.toContain(
    "your Macs",
  );
  const all = plan({ macs: ["local", "air", "spare", "mini"], of: 4 });
  const allHtml = renderToStaticMarkup(<UpdateBody plan={all} updating={false} />);
  expect(allHtml).toContain('title="On all 4 of your Macs"');
  expect(allHtml).toMatch(/<\/svg>4<\/span>/);
  const some = plan({ macs: ["local", "air"], of: 3 });
  const someHtml = renderToStaticMarkup(<UpdateBody plan={some} updating={false} />);
  expect(someHtml).toContain('title="On 2 of your Macs"');
  expect(someHtml).toMatch(/<\/svg>2<\/span>/);
});

test("while it installs, it says what happens next", () => {
  const html = renderToStaticMarkup(<UpdateBody plan={plan()} updating />);
  expect(html).toContain("Updating to 1.44.0");
  expect(html).toContain("Agents reconnect on their own.");
  expect(html).not.toContain("<button");
});
