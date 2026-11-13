import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

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
const ENTRIES = ["index.ts", "react.ts", "testing/index.ts", "canvas/index.ts", "model/index.ts"];
const PACKAGES = resolve(import.meta.dir, "../..");
const ROOT = resolve(PACKAGES, "..");
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

test("the shared rules run on the phone as they are: no React, no DOM, and only pure modules", async () => {
  // The other entries leave React to the app; the rules must not reach for it at all.
  const loaded: string[] = [];
  const built = await Bun.build({
    entrypoints: [`${import.meta.dir}/model/index.ts`],
    target: "browser",
    conditions: ["react-native"],
    plugins: [
      {
        name: "record",
        setup(build) {
          build.onLoad({ filter: /./ }, ({ path }) => {
            loaded.push(path.slice(ROOT.length + 1));
            return undefined;
          });
        },
      },
    ],
  });
  expect(built.success).toBe(true);
  expect(loaded).toContain("packages/client/src/model/status.ts");
  // Every module the rules run: their own, the client's error type, the runner protocol's
  // constants and search's text rules (files that import nothing).
  const outside = loaded.filter(
    (path) =>
      !path.startsWith("packages/client/src/model/") &&
      path !== "packages/client/src/errors.ts" &&
      path !== "apps/runner/src/api/protocol.ts" &&
      path !== "packages/core/src/search-text.ts",
  );
  expect(outside).toEqual([]);
  const code = await built.outputs[0]!.text();
  expect(code).not.toMatch(/\breact\b/i);
});

test("the shared rules typecheck with no DOM: nothing a browser alone has", () => {
  // A list of DOM names would miss the next one (`matchMedia`, `location`), so the compiler
  // checks the rules against the language's own library, with no DOM and no Bun or Node types.
  // Only errors in the model count: the client's request types it reads (session.ts, rpc.ts)
  // name `RequestInfo`, which React Native declares and the bare library does not.
  const base = ts.readConfigFile(resolve(ROOT, "tsconfig.base.json"), ts.sys.readFile).config;
  const { options } = ts.parseJsonConfigFileContent(
    { compilerOptions: { ...base.compilerOptions, lib: ["ES2023"], types: [] } },
    ts.sys,
    ROOT,
  );
  const program = ts.createProgram([`${import.meta.dir}/model/index.ts`], options);
  const model = `${import.meta.dir}/model/`;
  const errors = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith(model))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      const text = ts.flattenDiagnosticMessageText(d.messageText, " ");
      return `${d.file!.fileName.slice(model.length)}:${line + 1} ${text}`;
    });
  expect(errors).toEqual([]);
  // The walk reached the rules themselves, so an empty list means something.
  expect(program.getSourceFile(`${model}status.ts`)).toBeDefined();
  // A whole program's typecheck: seconds, not milliseconds.
}, 30_000);

test("the import scan sees a type-only import of the canvas", () => {
  // The bundle drops type imports, so this scan is what catches one: prove it does.
  expect(specifiers('import type { CanvasSource } from "@ponzu/canvas";')).toEqual([
    "@ponzu/canvas",
  ]);
  expect(specifiers('export type { X } from "@ponzu/render/types";')).toEqual([
    "@ponzu/render/types",
  ]);
  expect(specifiers('const m = await import("@ponzu/render");')).toEqual(["@ponzu/render"]);
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
 * Walks every workspace file the phone's typecheck reaches from `entry` (this package and core,
 * and the types it takes from the API and the runner, such as `AppType`), and lists each import
 * of a barred package, as "specifier from file". A specifier it follows but cannot resolve is
 * listed too, so the walk can never pass by quietly stopping short.
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
      const from = `${spec} from ${file.slice(ROOT.length + 1)}`;
      if (BARRED.test(spec)) {
        found.push(from);
        continue;
      }
      if (!spec.startsWith(".") && !spec.startsWith("@ponzu/")) continue;
      let path: string;
      try {
        path = Bun.resolveSync(spec, dirname(file));
      } catch {
        found.push(`${from} (unresolved)`);
        continue;
      }
      if (BARRED_DIR.test(path)) found.push(from);
      else if (path.startsWith(`${ROOT}/`) && !path.includes("/node_modules/")) queue.push(path);
    }
  }
  return found;
}
