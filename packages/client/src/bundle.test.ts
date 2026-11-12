import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";

/*
 * The phone bundles this package with Metro for Hermes: no Node, no DOM in the core, and none
 * of the API's runtime. A bundle made the way Expo resolves (the `react-native` condition, for
 * a browser-like target) holds the package to that. What Hermes itself lacks is in the README
 * ("On the phone").
 *
 * The phone also runs `CloudSource` (canvas/index.ts) on its React Native side, so nothing here
 * may reach the canvas's React code or the renderer: not in the bundle, and not as a type
 * either, since a type import drags those packages into the phone's typecheck.
 */

const NODE = new RegExp(`^(node:|(${builtinModules.join("|")})(/|$))`);
const ENTRIES = ["index.ts", "react.ts", "testing/index.ts", "canvas/index.ts"];
const PACKAGES = resolve(import.meta.dir, "../..");
/** The packages the phone must never take in, by name and by where their source is. */
const BARRED = /^@ponzu\/(canvas|render|server)(\/|$)/;
const BARRED_DIR = new RegExp(
  `^${PACKAGES.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(canvas|render|server)/`,
);

for (const entry of ENTRIES) {
  test(`${entry} bundles for React Native with nothing from Node or the API's runtime`, async () => {
    // Bun would quietly stand in for a Node module in a browser bundle: catch the import itself.
    const fromNode: string[] = [];
    const barred: string[] = [];
    const built = await Bun.build({
      entrypoints: [`${import.meta.dir}/${entry}`],
      target: "browser",
      conditions: ["react-native"],
      external: ["react"],
      plugins: [
        {
          name: "no-node",
          setup(build) {
            build.onResolve({ filter: NODE }, ({ path, importer }) => {
              fromNode.push(`${path} from ${importer}`);
              return { path, external: true };
            });
            build.onLoad({ filter: BARRED_DIR }, ({ path }) => {
              barred.push(path.slice(PACKAGES.length + 1));
              return undefined;
            });
          },
        },
      ],
    });
    expect(built.success).toBe(true);
    expect(fromNode).toEqual([]);
    expect(barred).toEqual([]);
    const code = await built.outputs[0]!.text();
    // What a slip into the API's or the database's code would bring along.
    expect(code).not.toContain("ZodError");
    expect(code).not.toContain("drizzle");
  });

  test(`${entry} imports nothing from the canvas, the renderer or the server, types included`, () => {
    expect(barredImports(`${import.meta.dir}/${entry}`)).toEqual([]);
  });
}

test("the import scan sees a type-only import of the canvas", () => {
  // The bundle drops type imports, so this scan is what catches one: prove it does.
  expect(specifiers('import type { CanvasSource } from "@ponzu/canvas";')).toEqual([
    "@ponzu/canvas",
  ]);
  expect(specifiers('export type { X } from "@ponzu/render/types";')).toEqual([
    "@ponzu/render/types",
  ]);
  expect(specifiers('const m = await import("@ponzu/server");')).toEqual(["@ponzu/server"]);
});

/** Every specifier a module names: imports, re-exports and dynamic imports, type-only ones too. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g)) {
    found.push((m[1] ?? m[2])!);
  }
  return found;
}

/**
 * Walks the source this package and core ship (the files Metro compiles for the phone) from
 * `entry`, and lists each import of a barred package, as "specifier from file".
 */
function barredImports(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      const from = `${spec} from ${file.slice(PACKAGES.length + 1)}`;
      if (BARRED.test(spec)) {
        found.push(from);
        continue;
      }
      if (!spec.startsWith(".") && !spec.startsWith("@ponzu/")) continue;
      let path: string;
      try {
        path = Bun.resolveSync(spec, dirname(file));
      } catch {
        continue;
      }
      if (BARRED_DIR.test(path)) found.push(from);
      else if (/^(client|core)\/src\//.test(path.slice(PACKAGES.length + 1))) queue.push(path);
    }
  }
  return found;
}
