import { expect, test } from "bun:test";
import { STUDIO_ORIGIN } from "./bridge.ts";
import { type Config, configFor } from "./config.ts";
import { contentSecurityPolicy } from "./csp.ts";
import { externalLink, isStudio } from "./navigation.ts";
import { built } from "./testing.ts";

const studio = [STUDIO_ORIGIN, "http://localhost:5173"];

test("the window stays on the studio", () => {
  expect(isStudio("ponzu-studio://app/", studio)).toBe(true);
  expect(isStudio("ponzu-studio://app/canvas/cnv_1?x=1", studio)).toBe(true);
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
    "ponzu://canvas/cnv_1",
    "vscode://file/etc/hosts",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "smb://server/share",
  ]) {
    expect(externalLink(url)).toBeNull();
  }
});

function policyOf(config: Config): Record<string, string[]> {
  return Object.fromEntries(
    contentSecurityPolicy(config)
      .split("; ")
      .map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
  );
}

test("the policy lets the studio script only itself, and reach only its environment's places", () => {
  const policy = policyOf(configFor(true, {}, built()));
  expect(policy["default-src"]).toEqual(["'none'"]);
  expect(policy["script-src"]).toEqual(["'self'"]);
  expect(policy["object-src"]).toEqual(["'none'"]);
  expect(policy["frame-src"]).toEqual(["'none'"]);
  expect(policy["base-uri"]).toEqual(["'none'"]);
  expect(policy["form-action"]).toEqual(["'none'"]);
  const connect = policy["connect-src"]!;
  expect(connect).toContain("https://api.ponzu.design");
  expect(connect.filter((source) => source.endsWith(".neon.tech"))).toHaveLength(2);
  // Exact hosts: no other Neon project, R2 bucket or ponzu.cloud host is a place to send things.
  expect(connect.join(" ")).not.toContain("*");
  expect(connect.join(" ")).not.toContain("r2.cloudflarestorage.com");
  expect(policy["font-src"]!.join(" ")).not.toContain("*");
  // Pictures from the web draw, as they do in the runner's previews; they run nothing.
  expect(policy["img-src"]).toContain("https:");
  expect(policy["img-src"]).not.toContain("http:");
});

test("a development build's policy reaches any environment's realtime and files", () => {
  const connect = policyOf(configFor(false, {}, built()))["connect-src"]!;
  expect(connect).toContain("wss://*.neon.tech");
  expect(connect).toContain("https://*.ponzu.cloud");
});

test("a packaged build talks to Ponzu Cloud whatever its environment says", () => {
  const env = { PONZU_API_URL: "https://evil.example", PONZU_STUDIO_URL: "http://localhost:5173" };
  expect(configFor(true, env, built())).toMatchObject({
    apiUrl: "https://api.ponzu.design",
    studioDevUrl: null,
    linkScheme: "ponzu",
  });
  expect(configFor(false, env, built())).toMatchObject({
    apiUrl: "https://evil.example",
    studioDevUrl: "http://localhost:5173",
    linkScheme: null,
  });
  // Plain http goes nowhere but this computer.
  expect(configFor(false, { PONZU_API_URL: "http://api.example" }, built()).apiUrl).toBe(
    "https://api.ponzu.design",
  );
});

test("a release ignores a developer's session and refuses remote debugging; a test build allows both", () => {
  const env = { PONZU_SESSION_FILE: "/tmp/planted.json" };
  expect(configFor(true, env, built())).toMatchObject({
    sessionFile: null,
    remoteDebugging: false,
  });
  expect(configFor(true, env, built({ test: true }))).toMatchObject({
    sessionFile: "/tmp/planted.json",
    remoteDebugging: true,
  });
  expect(configFor(false, env, built()).sessionFile).toBe("/tmp/planted.json");
});

test("Ponzu Dev is the release under its own name and links, without 1.x's cleanup or updates", () => {
  const env = { PONZU_API_URL: "https://evil.example", PONZU_SESSION_FILE: "/tmp/planted.json" };
  const release = configFor(true, env, built());
  const dev = configFor(true, env, built({ variant: "dev" }));
  expect(dev).toMatchObject({
    appName: "Ponzu Dev",
    linkScheme: "ponzu-dev",
    cleansUpLegacy: false,
    updates: false,
  });
  expect(release).toMatchObject({ cleansUpLegacy: true, updates: true });
  // Everything else is the release's: where it talks to, and no developer's doors.
  const { appName: _a, linkScheme: _l, cleansUpLegacy: _c, updates: _u, ...same } = dev;
  expect(release).toMatchObject(same);
  expect(contentSecurityPolicy(dev)).toBe(contentSecurityPolicy(release));
  expect(dev).toMatchObject({ sessionFile: null, remoteDebugging: false });

  // Three apps, three names: none shares another's folder, keychain item or lock, and only the
  // installed two take links, each its own.
  const apps = [release, dev, configFor(false, {}, built())];
  expect(new Set(apps.map((app) => app.appName)).size).toBe(3);
  expect(apps.map((app) => app.linkScheme)).toEqual(["ponzu", "ponzu-dev", null]);
  expect(apps.filter((app) => app.cleansUpLegacy)).toEqual([release]);
});
