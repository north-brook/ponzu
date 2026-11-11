import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Ask } from "../model.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { NeedsYou } from "./needs-you.tsx";

const handOff = (url: string): Ask => ({
  id: "q_link",
  status: "open",
  answeredBy: null,
  kind: "link",
  title: "Sign in so Claude can read the brand file",
  url,
  description: null,
});

const render = (ask: Ask) =>
  renderToStaticMarkup(
    <TipProvider>
      <NeedsYou
        asks={[ask]}
        meId="bryce"
        repoName="fernwood"
        onAnswer={() => {}}
        onDismiss={() => {}}
        onOpenLink={() => {}}
      />
    </TipProvider>,
  );

test("a hand-off to the web offers to open it", () => {
  const out = render(handOff("https://www.figma.com/login"));
  expect(out).toContain("Open www.figma.com");
  expect(out).toContain("data-option");
});

test("a hand-off anywhere but the web is shown, never opened, and can't be answered", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///Applications/Terminal.app",
    "ponzu-helper://run",
    "not a url",
  ]) {
    const out = render(handOff(url));
    // Its address is there to read, as text, with nothing to press.
    expect(out).toContain("Not a web address, so Ponzu won&#x27;t open it:");
    expect(out).not.toContain("data-option");
    expect(out).not.toContain("href=");
    expect(out).toMatch(/aria-label="Send" aria-disabled="true"/);
  }
});
