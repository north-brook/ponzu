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

test("names the Macs only when there's more than this one", () => {
  expect(renderToStaticMarkup(<UpdateBody plan={plan()} updating={false} />)).not.toContain(
    "your Macs",
  );
  const all = plan({ macs: ["local", "air", "spare", "mini"], of: 4 });
  expect(renderToStaticMarkup(<UpdateBody plan={all} updating={false} />)).toContain(
    "On all 4 of your Macs",
  );
  const some = plan({ macs: ["local", "air"], of: 3 });
  expect(renderToStaticMarkup(<UpdateBody plan={some} updating={false} />)).toContain(
    "On 2 of your Macs",
  );
});

test("while it installs, it says what happens next", () => {
  const html = renderToStaticMarkup(<UpdateBody plan={plan()} updating />);
  expect(html).toContain("Updating to 1.44.0");
  expect(html).toContain("Agents reconnect on their own.");
  expect(html).not.toContain("<button");
});
