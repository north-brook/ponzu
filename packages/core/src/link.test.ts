import { expect, test } from "bun:test";
import { designLink, parseDesignLink } from "./link.ts";

test("a design link opens the Mac app, or a server's canvas", () => {
  expect(designLink("/Users/sam/app/design/app.design")).toBe(
    "ponzu://open?file=/Users/sam/app/design/app.design",
  );
  expect(designLink("/Users/sam/app.design", { artboard: "ab_hero" })).toBe(
    "ponzu://open?file=/Users/sam/app.design&artboard=ab_hero",
  );
  expect(designLink("/d/a.design", { origin: "http://localhost:7777" })).toBe(
    "http://localhost:7777/?file=/d/a.design",
  );
});

test("a design link escapes what would end it in chat or in a query", () => {
  const link = designLink("/Users/sam/My Designs/50% & up (v2).design", { artboard: "ab_1" });
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
  ])
    expect(parseDesignLink(raw)).toBeNull();
});
