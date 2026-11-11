import { expect, test } from "bun:test";
import { designAppLink } from "./app-link";

test("a design opens in Ponzu, or in the app the link names", () => {
  expect(designAppLink("dsn_1")).toBe("ponzu://design/dsn_1");
  expect(designAppLink("dsn_1", "ponzu-preview")).toBe("ponzu-preview://design/dsn_1");
  expect(designAppLink("dsn_1", "ponzu-dev")).toBe("ponzu-dev://design/dsn_1");
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
    expect(designAppLink("dsn_1", app)).toBe("ponzu://design/dsn_1");
  }
  expect(designAppLink("dsn 1")).toBeNull();
  expect(designAppLink("../x", "ponzu-preview")).toBeNull();
});
