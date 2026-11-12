import { expect, test } from "bun:test";
import { GITHUB, retiredRepo } from "./retired.ts";

test("a viewer link keeps its repo, without the ref or the path", () => {
  expect(retiredRepo(["north-brook", "ponzu", "examples", "kettle.design"])).toEqual({
    href: "https://github.com/north-brook/ponzu",
    name: "north-brook/ponzu",
  });
  expect(retiredRepo(["o", "r@v1.2", "d", "a.design"])).toEqual({
    href: "https://github.com/o/r",
    name: "o/r",
  });
  // As Next hands it over, still percent-encoded.
  expect(retiredRepo(["north-brook", "ponzu%40main", "examples", "kettle.design"])).toEqual({
    href: "https://github.com/north-brook/ponzu",
    name: "north-brook/ponzu",
  });
  expect(retiredRepo(["Some-Org", "my.repo_name-2"])).toEqual({
    href: "https://github.com/Some-Org/my.repo_name-2",
    name: "Some-Org/my.repo_name-2",
  });
});

test("a slug that names no repo links to github.com and nothing from it", () => {
  const none = { href: GITHUB, name: null };
  const forged = [
    undefined,
    [],
    ["north-brook"],
    ["..", "ponzu"],
    ["north-brook", ".."],
    ["north-brook", "."],
    ["north-brook", "@main"],
    ["javascript:alert(1)", "x"],
    ["o", "javascript:alert(1)"],
    ["o", "r/../../evil.com"],
    ["evil.com", "r"],
    ["o", "r?x=1"],
    ["o", "r#x"],
    ["o", "r%2F.."],
    ["o", "%2E%2E"],
    ["%2F%2Fevil.com", "r"],
    ["o", "%E0%A4%A"],
    ["javascript%3Aalert(1)", "x"],
    ["o", "<script>"],
    ["o", " r"],
    ["", "r"],
    ["o".repeat(40), "r"],
    ["o", "r".repeat(101)],
    ["o", "r".repeat(200)],
    ["o".repeat(200), "r".repeat(200)],
  ];
  for (const slug of forged) expect(retiredRepo(slug)).toEqual(none);
});

test("the longest names GitHub allows still link to them", () => {
  const owner = "o".repeat(39);
  const repo = "r".repeat(100);
  expect(retiredRepo([owner, repo]).href).toBe(`https://github.com/${owner}/${repo}`);
});

test("every answer links to github.com only", () => {
  const slugs = [
    ["north-brook", "ponzu"],
    ["a", "b@c"],
    ["javascript:", "x"],
    ["//evil.com", "x"],
  ];
  for (const slug of slugs) {
    const url = new URL(retiredRepo(slug).href);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("github.com");
  }
});
