import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/*
 * What @ponzu/email may touch (designs/email.md §3.1): plain data in, strings out. It never
 * imports the canvas, the renderer, the server, the database or Resend (the API's mail seam is
 * the only importer of `resend`), and the iPhone app never imports it.
 */
const PACKAGE = resolve(import.meta.dir, "..");
const ROOT = resolve(PACKAGE, "../..");

function files(dir: string, skip: ReadonlySet<string> = new Set()): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (skip.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, skip);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) ? [path] : [];
  });
}

const importsOf = (source: string) =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

const FORBIDDEN = /^(@ponzu\/(canvas|render|server|db)|resend)(\/|$)/;

test("the package's code imports nothing it must not", () => {
  for (const dir of ["src", "emails"]) {
    for (const file of files(join(PACKAGE, dir))) {
      if (file.endsWith(".test.ts")) continue;
      for (const specifier of importsOf(readFileSync(file, "utf8"))) {
        expect({ file, specifier, forbidden: FORBIDDEN.test(specifier) }).toEqual({
          file,
          specifier,
          forbidden: false,
        });
      }
    }
  }
});

test("its dependencies are React Email and React, pinned as the design says", () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
  expect(Object.keys(pkg.dependencies).sort()).toEqual(["react", "react-dom", "react-email"]);
  expect(pkg.dependencies["react-email"]).toBe("6.11.5");
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  // The preview server's package sits in the root's devDependencies, not this package's: the
  // API's filtered install on Vercel (`--filter @ponzu/api`) installs a workspace dependency's
  // devDependencies, and @react-email/ui brings Next.js, about 300 MB the API never uses.
  // `email dev` still finds it, resolving up from packages/email.
  expect(root.devDependencies["@react-email/ui"]).toBe("6.11.5");
  expect(pkg.devDependencies["@react-email/ui"]).toBeUndefined();
  expect(root.overrides["@react-email/render"]).toBe("2.2.0");
  for (const name of [
    "@react-email/components",
    "@react-email/tailwind",
    "@react-email/preview-server",
  ]) {
    expect(pkg.dependencies[name] ?? pkg.devDependencies[name]).toBeUndefined();
  }
});

test("only the API depends on it, and the iPhone app never imports it", () => {
  const dependents = readdirSync(join(ROOT, "apps")).filter((app) => {
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "apps", app, "package.json"), "utf8"));
      return "@ponzu/email" in { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      return false;
    }
  });
  expect(dependents).toEqual(["api"]);

  const mobile = files(
    join(ROOT, "apps/mobile"),
    new Set(["node_modules", "ios", "android", ".expo"]),
  );
  expect(mobile.length).toBeGreaterThan(0);
  for (const file of mobile) {
    expect({ file, imports: readFileSync(file, "utf8").includes("@ponzu/email") }).toEqual({
      file,
      imports: false,
    });
  }
});

test("release-please leaves it out of the desktop app's releases", () => {
  const config = JSON.parse(readFileSync(join(ROOT, "release-please-config.json"), "utf8"));
  expect(config.packages["."]["exclude-paths"]).toContain("packages/email");
});
