import { expect, test } from "bun:test";
import { appLink, designLink, parseDesignLink } from "./link.ts";

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
    "ponzu://open?mac=&file=/d/a.design",
    "ponzu://open?mac=air.evil.com&file=/d/a.design",
    "ponzu://open?mac=../air&file=/d/a.design",
  ])
    expect(parseDesignLink(raw)).toBeNull();
});
