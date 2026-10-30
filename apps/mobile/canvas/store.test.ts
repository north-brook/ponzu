import { expect, test } from "bun:test";
import { emptyDoc } from "@ponzu/core";

// The store reads the system's theme as it loads.
globalThis.matchMedia ??= (() => ({ matches: false })) as unknown as typeof matchMedia;
const { getState, receive, setPage } = await import("./store.ts");

const doc = {
  ...emptyDoc("App"),
  pages: [
    { id: "pg_app", name: "App", artboards: [] },
    { id: "pg_flow", name: "Flow", artboards: [] },
  ],
};
const sent = (page?: string, file = "/d/a.design") =>
  receive({ t: "doc", doc, assetBase: "", theme: "light", file, ...(page ? { page } : {}) });

test("a link's page opens the design, and the doc sent again keeps the person's", () => {
  sent("pg_flow");
  expect(getState().pageId).toBe("pg_flow");
  setPage("pg_app");
  sent("pg_flow");
  expect(getState().pageId).toBe("pg_app");
  // Another design opens on its own page.
  sent("pg_flow", "/d/b.design");
  expect(getState().pageId).toBe("pg_flow");
});
