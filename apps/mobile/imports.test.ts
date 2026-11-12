import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/*
 * What the React Native bundle may import (docs/mobile.md, "The imports rule"). Files under
 * app/, lib/ and components/ may use @ponzu/core and @ponzu/client, never the packages built
 * for a browser or a server, and never another package's source by path: those would drag
 * the DOM, Node or a second React into Hermes. The canvas page (canvas/) is a browser bundle
 * and is not under this rule. Tests are: they import what they test, and nothing they import
 * ships, so they alone may reach a package's source by path.
 */

const ROOT = import.meta.dir;
const CHECKED = ["app", "lib", "components"];
const FORBIDDEN = [
  "@ponzu/canvas",
  "@ponzu/render",
  "@ponzu/server",
  "@ponzu/db",
  "@ponzu/sandbox",
  "@ponzu/tools",
  "@ponzu/api",
  "@ponzu/store",
];
/** The only file that may reach another package's source: pure data, the icon names. */
const PATH_ALLOWED: Record<string, string[]> = {
  "lib/page-icons.ts": ["packages/canvas/src/icon-names.ts"],
};
/** The fake (and its tests) alone may use the client's testing entry. */
const TESTING_ALLOWED = ["lib/cloud/backend.fake.ts"];
/** Modules only one file may import. */
const PRIVATE: Record<string, string[]> = {
  // A stand-in for @ponzu/core/links: lib/links.ts is the one reader of links.
  "lib/link-grammar.ts": ["lib/links.ts", "lib/links.test.ts"],
};

const isTest = (file: string) => /\.(test|rntest)\.tsx?$/.test(file);

/** Every module `source` imports or requires, by its specifier. */
function specifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[\w*{}\s,]+\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\bmock\.module\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) for (const [, spec] of source.matchAll(pattern)) found.add(spec!);
  return [...found];
}

/** What `file` (relative to apps/mobile) breaks of the rule, in words. */
function violations(file: string, source: string): string[] {
  const out: string[] = [];
  const test = isTest(file);
  for (const spec of specifiers(source)) {
    if (FORBIDDEN.some((name) => spec === name || spec.startsWith(`${name}/`))) {
      out.push(`${file} imports ${spec}`);
      continue;
    }
    if (spec === "@ponzu/client/testing" && !test && !TESTING_ALLOWED.includes(file)) {
      out.push(`${file} imports ${spec}, which only the fake backend may`);
      continue;
    }
    if (!spec.startsWith(".")) continue;
    const target = relative(ROOT, resolve(join(ROOT, file, ".."), spec));
    if (target.startsWith("..")) {
      const outside = relative(resolve(ROOT, "../.."), resolve(ROOT, target));
      if (/^packages\/[^/]+\/src\//.test(outside)) {
        if (!test && !(PATH_ALLOWED[file] ?? []).some((allowed) => outside.startsWith(allowed))) {
          out.push(`${file} imports ${outside} by path`);
        }
      } else if (!test) {
        out.push(`${file} imports ${outside}, outside the app`);
      }
      continue;
    }
    for (const [module, readers] of Object.entries(PRIVATE)) {
      const base = module.replace(/\.tsx?$/, "");
      if ((target === base || target === module) && !readers.includes(file)) {
        out.push(`${file} imports ${module}, which only ${readers[0]} may`);
      }
    }
  }
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the imports rule", () => {
  test("app/, lib/ and components/ keep it", () => {
    const files = CHECKED.flatMap(sources);
    expect(files.length).toBeGreaterThan(50);
    const broken = files.flatMap((file) =>
      violations(file, readFileSync(join(ROOT, file), "utf8")),
    );
    expect(broken).toEqual([]);
  });

  test("it catches each way of breaking it", () => {
    expect(violations("app/x.tsx", 'import { Canvas } from "@ponzu/canvas";')).toHaveLength(1);
    expect(violations("lib/x.ts", 'import type { Doc } from "@ponzu/render/doc";')).toHaveLength(1);
    expect(violations("components/x.tsx", 'const s = require("@ponzu/server");')).toHaveLength(1);
    expect(
      violations("lib/x.ts", 'import { Artboard } from "../../../packages/canvas/src/Artboard";'),
    ).toEqual(["lib/x.ts imports packages/canvas/src/Artboard by path"]);
    expect(
      violations("app/(tabs)/x.tsx", 'import "../../../../packages/canvas/src/icon-names.ts";'),
    ).toHaveLength(1);
    expect(
      violations("lib/x.ts", 'export { a } from "../../../packages/core/src/doc.ts";'),
    ).toHaveLength(1);
    expect(
      violations("app/x.tsx", 'import { createFakeBackend } from "@ponzu/client/testing";'),
    ).toHaveLength(1);
    expect(
      violations("app/x.tsx", 'import { parseAppLink } from "../lib/link-grammar";'),
    ).toHaveLength(1);
    // What the rule allows.
    expect(
      violations(
        "lib/page-icons.ts",
        'import { a } from "../../../packages/canvas/src/icon-names.ts";',
      ),
    ).toEqual([]);
    expect(
      violations("lib/cloud/backend.fake.ts", 'import { x } from "@ponzu/client/testing";'),
    ).toEqual([]);
    expect(violations("lib/x.ts", 'import { createApi } from "@ponzu/client";')).toEqual([]);
    expect(violations("lib/x.ts", 'import { applyOp } from "@ponzu/core";')).toEqual([]);
  });
});

describe("the backend swap", () => {
  const { backendFile } = require("./metro.resolve.js") as {
    backendFile(origin: string, moduleName: string, root: string): string | null;
  };

  test("an import of lib/cloud/backend is the fake's file, from anywhere in the app", () => {
    const fake = join(ROOT, "lib/cloud/backend.fake.ts");
    expect(backendFile(join(ROOT, "app/index.tsx"), "../lib/cloud/backend", ROOT)).toBe(fake);
    expect(backendFile(join(ROOT, "lib/cloud/query.tsx"), "./backend", ROOT)).toBe(fake);
    expect(
      backendFile(
        join(ROOT, "app/(tabs)/(canvases)/canvases.tsx"),
        "../../../lib/cloud/backend",
        ROOT,
      ),
    ).toBe(fake);
  });

  test("nothing else is swapped", () => {
    expect(backendFile(join(ROOT, "app/index.tsx"), "../lib/cloud/backend.fake", ROOT)).toBeNull();
    expect(backendFile(join(ROOT, "lib/cloud/query.tsx"), "./types", ROOT)).toBeNull();
    expect(backendFile(join(ROOT, "lib/x.ts"), "@ponzu/client", ROOT)).toBeNull();
    expect(backendFile(join(ROOT, "lib/backend.ts"), "./backend", ROOT)).toBeNull();
  });

  test("the real backend never imports the fake, and the fake is imported by nothing", () => {
    const files = CHECKED.flatMap(sources).filter((file) => !isTest(file));
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(specifiers(source).filter((spec) => spec.endsWith("backend.fake"))).toEqual([]);
    }
  });
});
