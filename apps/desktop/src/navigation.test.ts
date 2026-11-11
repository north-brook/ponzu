import { expect, test } from "bun:test";
import { STUDIO_ORIGIN } from "./bridge.ts";
import { configFor } from "./config.ts";
import { contentSecurityPolicy } from "./csp.ts";
import { externalLink, isStudio } from "./navigation.ts";

const studio = [STUDIO_ORIGIN, "http://localhost:5173"];

test("the window stays on the studio", () => {
  expect(isStudio("ponzu-studio://app/", studio)).toBe(true);
  expect(isStudio("ponzu-studio://app/design/dsn_1?x=1", studio)).toBe(true);
  expect(isStudio("http://localhost:5173/", studio)).toBe(true);
  for (const url of [
    "ponzu-studio://other/",
    "http://localhost:5174/",
    "https://ponzu.design/",
    "https://assets.ponzu.cloud/key/assets/a.svg",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "",
  ]) {
    expect(isStudio(url, studio)).toBe(false);
  }
  expect(isStudio(undefined, studio)).toBe(false);
});

test("only plain https links leave for the browser", () => {
  expect(externalLink("https://github.com/north-brook/ponzu/pull/1")).toBe(
    "https://github.com/north-brook/ponzu/pull/1",
  );
  for (const url of [
    "http://example.com/",
    "file:///Applications/Calculator.app",
    "ponzu://design/dsn_1",
    "vscode://file/etc/hosts",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "smb://server/share",
  ]) {
    expect(externalLink(url)).toBeNull();
  }
});

test("the policy lets the studio script only itself, and reach only Ponzu's places", () => {
  const policy = Object.fromEntries(
    contentSecurityPolicy("https://api.ponzu.design")
      .split("; ")
      .map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
  );
  expect(policy["default-src"]).toEqual(["'none'"]);
  expect(policy["script-src"]).toEqual(["'self'"]);
  expect(policy["object-src"]).toEqual(["'none'"]);
  expect(policy["frame-src"]).toEqual(["'none'"]);
  expect(policy["base-uri"]).toEqual(["'none'"]);
  expect(policy["form-action"]).toEqual(["'none'"]);
  expect(policy["connect-src"]).toContain("https://api.ponzu.design");
  expect(policy["connect-src"]).toContain("wss://*.neon.tech");
  expect(policy["img-src"]).toContain("https://*.ponzu.cloud");
  // Design content is never served from Ponzu's own domain.
  expect(policy["img-src"]).not.toContain("https://*.ponzu.design");
});

test("a packaged build talks to Ponzu Cloud whatever its environment says", () => {
  const env = { PONZU_API_URL: "https://evil.example", PONZU_STUDIO_URL: "http://localhost:5173" };
  expect(configFor(true, env)).toMatchObject({
    apiUrl: "https://api.ponzu.design",
    studioDevUrl: null,
    linkScheme: "ponzu",
  });
  expect(configFor(false, env)).toMatchObject({
    apiUrl: "https://evil.example",
    studioDevUrl: "http://localhost:5173",
    linkScheme: "ponzu-dev",
  });
  // Plain http goes nowhere but this computer.
  expect(configFor(false, { PONZU_API_URL: "http://api.example" }).apiUrl).toBe(
    "https://api.ponzu.design",
  );
});
