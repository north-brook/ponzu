import { expect, test } from "bun:test";
import { type Artboard, type Doc, emptyDoc } from "./index.ts";
import { appLink, designLink, linkTarget, parseDesignLink } from "./link.ts";

test("a design link opens ponzu.design's open page, or a server's canvas", () => {
  expect(designLink("/Users/sam/app/design/app.design")).toBe(
    "https://ponzu.design/local#file=/Users/sam/app/design/app.design",
  );
  expect(designLink("/Users/sam/app.design", { artboard: "ab_hero" })).toBe(
    "https://ponzu.design/local#file=/Users/sam/app.design&artboard=ab_hero",
  );
  expect(designLink("/d/a.design", { origin: "http://localhost:7777" })).toBe(
    "http://localhost:7777/?file=/d/a.design",
  );
});

test("the open page hands the Mac app the same design, by ponzu://", () => {
  const link = designLink("/Users/sam/app.design", { artboard: "ab_hero" });
  const app = appLink("/Users/sam/app.design", { artboard: "ab_hero" });
  expect(app).toBe("ponzu://open?file=/Users/sam/app.design&artboard=ab_hero");
  expect(`ponzu://open?${new URL(link).hash.slice(1)}`).toBe(app);
});

test("a design link names the Mac it's on, for the person's other Macs to open it from", () => {
  const link = designLink("/Users/sam/app.design", { artboard: "ab_hero", mac: "workstation" });
  expect(link).toBe(
    "https://ponzu.design/local#mac=workstation&file=/Users/sam/app.design&artboard=ab_hero",
  );
  expect(parseDesignLink(`ponzu://open?${new URL(link).hash.slice(1)}`)).toEqual({
    path: "/Users/sam/app.design",
    artboard: "ab_hero",
    mac: "workstation",
  });
  // A canvas link is its own server's: no Mac to name. A name that isn't one is left out.
  expect(designLink("/d/a.design", { origin: "http://localhost:7777", mac: "air" })).toBe(
    "http://localhost:7777/?file=/d/a.design",
  );
  expect(appLink("/d/a.design", { mac: "Sam's Mac" })).toBe("ponzu://open?file=/d/a.design");
});

test("a design link can open on a page, the board on it or not", () => {
  const link = designLink("/Users/sam/app.design", { page: "pg_flow", artboard: "ab_hero" });
  expect(link).toBe(
    "https://ponzu.design/local#file=/Users/sam/app.design&page=pg_flow&artboard=ab_hero",
  );
  expect(parseDesignLink(`ponzu://open?${new URL(link).hash.slice(1)}`)).toEqual({
    path: "/Users/sam/app.design",
    page: "pg_flow",
    artboard: "ab_hero",
  });
  expect(designLink("/d/a.design", { origin: "http://localhost:7777", page: "pg_flow" })).toBe(
    "http://localhost:7777/?file=/d/a.design&page=pg_flow",
  );
  expect(parseDesignLink("ponzu://open?file=/d/a.design&page=pg_flow")).toEqual({
    path: "/d/a.design",
    page: "pg_flow",
  });
});

test("a design link escapes what would end it in chat or in a query", () => {
  const link = appLink("/Users/sam/My Designs/50% & up (v2).design", { artboard: "ab_1" });
  expect(link).toBe(
    "ponzu://open?file=/Users/sam/My%20Designs/50%25%20%26%20up%20%28v2%29.design&artboard=ab_1",
  );
  expect(parseDesignLink(link)).toEqual({
    path: "/Users/sam/My Designs/50% & up (v2).design",
    artboard: "ab_1",
  });
});

test("reads the links agents hand out", () => {
  expect(parseDesignLink("ponzu://open?file=/d/a.design")).toEqual({ path: "/d/a.design" });
  expect(parseDesignLink("ponzu:open?file=/d/a.design/&artboard=ab_x")).toEqual({
    path: "/d/a.design",
    artboard: "ab_x",
  });
  expect(parseDesignLink("ponzu://open?file=%2Fd%2Fa.design")).toEqual({ path: "/d/a.design" });
});

test("refuses links that aren't one design, by absolute path", () => {
  for (const raw of [
    "not a link",
    "https://ponzu.design/?file=/d/a.design",
    "ponzu://serve?file=/d/a.design",
    "ponzu://open?repo=o/r&path=a.design",
    "ponzu://open?file=d/a.design",
    "ponzu://open?file=/d/a",
    "ponzu://open?file=/d/../etc/a.design",
    "ponzu://open?file=/d/./a.design",
    "ponzu://open?file=//d/a.design",
    "ponzu://open?file=/d/a%00.design",
    "ponzu://open?file=/d/a.design&artboard=",
    "ponzu://open?file=/d/a.design&artboard=ab%20x",
    "ponzu://open?file=/d/a.design&artboard=../x",
    "ponzu://open?file=/d/a.design&page=",
    "ponzu://open?file=/d/a.design&page=Flow%20one",
    "ponzu://open?mac=&file=/d/a.design",
    "ponzu://open?mac=air.evil.com&file=/d/a.design",
    "ponzu://open?mac=../air&file=/d/a.design",
  ])
    expect(parseDesignLink(raw)).toBeNull();
});

const board = (id: string): Artboard => ({
  id,
  name: id,
  x: 0,
  y: 0,
  root: { kind: "el", id, tag: "div", attrs: {}, style: {}, children: [] },
});
const doc: Doc = {
  ...emptyDoc("App"),
  pages: [
    { id: "pg_app", name: "App", artboards: [board("ab_home")] },
    { id: "pg_flow", name: "Flow", artboards: [board("ab_step")] },
  ],
};

test("a link opens on its board's page, framed on the board", () => {
  expect(linkTarget(doc, { artboard: "ab_step" })).toEqual({
    pageId: "pg_flow",
    artboardId: "ab_step",
  });
  expect(linkTarget(doc, { page: "pg_flow", artboard: "ab_step" })).toEqual({
    pageId: "pg_flow",
    artboardId: "ab_step",
  });
});

test("a link's page wins over a board that isn't on it", () => {
  expect(linkTarget(doc, { page: "pg_flow" })).toEqual({ pageId: "pg_flow" });
  expect(linkTarget(doc, { page: "pg_flow", artboard: "ab_home" })).toEqual({ pageId: "pg_flow" });
  expect(linkTarget(doc, { page: "pg_flow", artboard: "ab_gone" })).toEqual({ pageId: "pg_flow" });
  expect(linkTarget(doc, { page: "Flow" })).toEqual({ pageId: "pg_flow" });
});

test("a link to what isn't there leaves the doc's own first page", () => {
  expect(linkTarget(doc, { page: "pg_gone", artboard: "ab_step" })).toEqual({
    pageId: "pg_flow",
    artboardId: "ab_step",
  });
  expect(linkTarget(doc, { page: "pg_gone" })).toBeNull();
  expect(linkTarget(doc, { artboard: "ab_gone" })).toBeNull();
  expect(linkTarget(doc, {})).toBeNull();
});
