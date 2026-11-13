import { expect, test } from "bun:test";
import { renderReturnPage, returnHandoff } from "./return-page.ts";

// The page Checkout and the portal come back to: its words, and the one link it may open, which
// is built only from the setup's row (the routes' tests prove the row is all it reads).

test("a card added opens the app the row names, with the setup and the result", () => {
  expect(returnHandoff({ kind: "added", setupId: "auth_7", scheme: "ponzu-dev" })).toEqual({
    documentTitle: "Card added",
    problem: false,
    view: { title: "Card added", body: "Opening Ponzu Dev…" },
    link: {
      href: "ponzu-dev://billing/card?setup=auth_7&result=added",
      app: "Ponzu Dev",
      opened: { title: "Card added", body: "Ponzu has it. You can close this tab." },
      missed: {
        title: "Card added",
        body: "If Ponzu didn't open, it picks this up when you go back to it.",
      },
    },
  });
});

test("cancelled links back with that; a build with no links gets none and the page closes", () => {
  expect(returnHandoff({ kind: "cancelled", setupId: "auth_7", scheme: "ponzu" }).link?.href).toBe(
    "ponzu://billing/card?setup=auth_7&result=cancelled",
  );
  expect(returnHandoff({ kind: "added", setupId: "auth_7", scheme: "none" })).toEqual({
    documentTitle: "Card added",
    problem: false,
    view: { title: "Card added", body: "Ponzu has it. You can close this tab." },
    link: null,
    closes: true,
  });
});

test("the pages with no link: the portal, an expired page, Stripe down, and nothing to finish", () => {
  const view = (kind: "portal" | "expired" | "unreachable" | "unknown") => {
    const page = returnHandoff({ kind });
    expect(page.link).toBeNull();
    return [page.view, page.problem];
  };
  expect(view("portal")).toEqual([
    { title: "Back to Ponzu", body: "You can close this tab." },
    false,
  ]);
  expect(view("expired")).toEqual([
    { title: "That took too long", body: "Go back to Ponzu to try again. You can close this tab." },
    false,
  ]);
  expect(view("unreachable")).toEqual([
    {
      title: "Ponzu couldn't reach Stripe",
      body: "If you added a card, Ponzu picks it up in a moment. You can close this tab.",
    },
    true,
  ]);
  expect(view("unknown")).toEqual([
    {
      title: "Nothing to finish here",
      body: "Go back to Ponzu to try again. You can close this tab.",
    },
    false,
  ]);
});

test("the page is the handoff document, under its strict policy", async () => {
  const { html, csp } = await renderReturnPage({
    kind: "added",
    setupId: "auth_7",
    scheme: "ponzu",
  });
  expect(html).toContain("<title>Card added · Ponzu</title>");
  expect(html).toContain(`data-link="ponzu://billing/card?setup=auth_7&amp;result=added"`);
  expect(csp).toStartWith("default-src 'none'; script-src 'sha256-");
});
