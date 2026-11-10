import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { onlyVersionChanged, scope, workspaces } from "./scope";

const packages = workspaces(resolve(import.meta.dir, "../.."));
const suites = (...files: string[]) => scope(files, packages);

test("a change to the phone alone runs only the phone's suites", () => {
  expect(suites("apps/mobile/app/index.tsx")).toEqual({ desktop: false, mobile: true });
});

test("a change to the Mac app, its server or its studio runs only the desktop suite", () => {
  for (const file of [
    "apps/desktop/src/main.ts",
    "apps/cli/src/index.ts",
    "apps/studio/src/App.tsx",
    "packages/server/src/serve.ts",
  ]) {
    expect(suites(file)).toEqual({ desktop: true, mobile: false });
  }
});

test("what both apps bundle runs both", () => {
  // The phone's canvas draws artboards with the studio's Artboard, which renders through
  // @ponzu/render, so render reaches the phone as well as the Mac.
  for (const file of ["packages/core/src/doc.ts", "packages/render/src/lint.ts"]) {
    expect(suites(file)).toEqual({ desktop: true, mobile: true });
  }
});

test("the studio's components the phone reads by path run the phone too", () => {
  // The phone can't depend on @ponzu/canvas, but its canvas and icons import its source.
  for (const file of [
    "packages/canvas/src/icon-names.ts",
    "packages/canvas/src/Artboard.tsx",
    "packages/canvas/src/arrive.ts",
  ]) {
    expect(suites(file).mobile).toBe(true);
  }
});

test("the cloud API and the packages only it uses run neither", () => {
  // "Check, typecheck, test" covers them on every pull request: the root typecheck includes
  // apps/api and its own tsconfig checks it against Node, `bun test` runs its tests, and
  // scripts/ci/api-bundle.ts builds and loads it.
  for (const file of [
    "apps/api/src/routes/me.ts",
    "apps/api/vercel.json",
    "packages/db/src/queries/accounts.ts",
    "packages/sandbox/src/boat.ts",
  ]) {
    expect(suites(file)).toEqual({ desktop: false, mobile: false });
  }
});

test("it still runs neither once the apps take its route types through the client", () => {
  // The typed client imports `AppType` from the API, and both apps will depend on the client.
  // A route change can break their typecheck, which every pull request runs, but cannot
  // change the desktop package or the phone's bundle.
  const withClient = [
    ...packages.map((workspace) =>
      ["desktop", "mobile"].includes(workspace.name)
        ? { ...workspace, dependencies: [...workspace.dependencies, "client"] }
        : workspace,
    ),
    { name: "client", dir: "packages/client", dependencies: ["api", "core"] },
  ];

  for (const file of ["apps/api/src/routes/me.ts", "packages/db/src/queries/accounts.ts"]) {
    expect(scope([file], withClient)).toEqual({ desktop: false, mobile: false });
  }
  // What the client runs still reaches them.
  expect(scope(["packages/client/src/index.ts"], withClient)).toEqual({
    desktop: true,
    mobile: true,
  });
});

test("the site runs neither", () => {
  expect(suites("apps/web/app/page.tsx")).toEqual({ desktop: false, mobile: false });
});

test("prose, designs and release bookkeeping run nothing", () => {
  expect(
    Object.values(
      suites(
        "docs/mobile.md",
        "AGENTS.md",
        "apps/mobile/maestro/README.md",
        "apps/mobile/CHANGELOG.md",
        "design/brand.design/pages/logo/05-app-icon.html",
        ".release-please-manifest.json",
        "release-please-config.json",
        ".github/workflows/release.yml",
      ),
    ),
  ).not.toContain(true);
});

test("a release is told by its diff, never its branch name", () => {
  const bump = [
    "diff --git a/apps/mobile/app.json b/apps/mobile/app.json",
    "--- a/apps/mobile/app.json",
    "+++ b/apps/mobile/app.json",
    "@@ -4 +4 @@",
    '-    "version": "0.1.0",',
    '+    "version": "0.2.0",',
  ].join("\n");
  expect(onlyVersionChanged(bump)).toBe(true);
  expect(onlyVersionChanged(`${bump}\n@@ -9 +9 @@\n-    "scheme": "a",\n+    "scheme": "b",`)).toBe(
    false,
  );
  expect(onlyVersionChanged("")).toBe(false);
});

test("anything outside the packages it cannot place runs everything", () => {
  for (const file of [
    "bun.lock",
    "package.json",
    "biome.json",
    "tsconfig.json",
    ".github/workflows/ci.yml",
    "scripts/ci/scope.ts",
    "scripts/release-notes.ts",
  ]) {
    expect(Object.values(suites(file))).not.toContain(false);
  }
});
