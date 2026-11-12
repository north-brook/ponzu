import { expect, test } from "bun:test";
import { appOf, canvasAppLink } from "./app-link";

test("the page names the app the link opens, and offers a download only of Ponzu", () => {
  expect(appOf("ponzu://canvas/cnv_1")).toEqual({ name: "Ponzu", release: true });
  expect(appOf("ponzu-dev://canvas/cnv_1")).toEqual({ name: "Ponzu Dev", release: false });
  expect(appOf("ponzu-preview://canvas/cnv_1")).toEqual({ name: "Ponzu Preview", release: false });
  expect(appOf(null)).toEqual({ name: "Ponzu", release: true });
});

test("a canvas opens in Ponzu, or in the app the link names", () => {
  expect(canvasAppLink("cnv_1")).toBe("ponzu://canvas/cnv_1");
  expect(canvasAppLink("cnv_1", "ponzu-preview")).toBe("ponzu-preview://canvas/cnv_1");
  expect(canvasAppLink("cnv_1", "ponzu-dev")).toBe("ponzu-dev://canvas/cnv_1");
});

test("no other scheme can come out of it, and no id that couldn't be one", () => {
  for (const app of [
    "javascript",
    "https",
    "http://evil.example",
    "ponzu-preview://x",
    "PONZU-PREVIEW",
    ["ponzu-preview"],
    "",
  ]) {
    expect(canvasAppLink("cnv_1", app)).toBe("ponzu://canvas/cnv_1");
  }
  expect(canvasAppLink("dsn 1")).toBeNull();
  expect(canvasAppLink("../x", "ponzu-preview")).toBeNull();
});

test("a page or board rides along to the app, when it could be an id", () => {
  expect(canvasAppLink("cnv_1", undefined, { artboard: "ab_x1" })).toBe(
    "ponzu://canvas/cnv_1?artboard=ab_x1",
  );
  expect(canvasAppLink("cnv_1", "ponzu-preview", { page: "pg_2" })).toBe(
    "ponzu-preview://canvas/cnv_1?page=pg_2",
  );
  for (const bad of ["ab x", "a&b=c", "", ["ab_1", "ab_2"], "x".repeat(65)]) {
    expect(canvasAppLink("cnv_1", undefined, { artboard: bad })).toBe("ponzu://canvas/cnv_1");
  }
});
