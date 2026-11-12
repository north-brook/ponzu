/*
 * Holds the SDK to the shape the design needs:
 *
 * 1. Nothing outside packages/sandbox/src imports @vercel/sandbox.
 * 2. vercel.ts touches a Sandbox only through calls that never resume: the static get, create,
 *    getOrCreate and list; the instance's getters, currentSession(), update(), delete() and
 *    domain(). Everything else on a Sandbox (runCommand, fs, readFile, writeFiles,
 *    extendTimeout, snapshot, …) goes through withResume and can wake it (sandbox.js 614-860).
 *    Session methods are pinned and always allowed. It is checked with the type checker, so no
 *    variable name can hide a call.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../../..");
const VERCEL_TS = join(import.meta.dir, "vercel.ts");

/**
 * Files outside this package still allowed to import the SDK while a track ports them. Each
 * entry must still import the SDK, so the list can only shrink. The image track emptied it.
 */
const PENDING_IMAGE_TRACK: string[] = [];

const STATIC_ALLOWED = new Set(["get", "create", "getOrCreate", "list"]);
const INSTANCE_ALLOWED = new Set([
  // getters
  "name",
  "routes",
  "persistent",
  "region",
  "vcpus",
  "memory",
  "image",
  "createdAt",
  "updatedAt",
  "status",
  "timeout",
  "expiresAt",
  "sourceSnapshotId",
  "currentSnapshotId",
  "snapshotExpiration",
  "keepLastSnapshots",
  // calls that never resume
  "currentSession",
  "update",
  "delete",
  "domain",
]);

const IMPORTS_SDK =
  /from\s+["']@vercel\/sandbox(\/[^"']*)?["']|import\(\s*["']@vercel\/sandbox|require\(\s*["']@vercel\/sandbox/;

test("nothing outside packages/sandbox/src imports @vercel/sandbox", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
  });
  expect(listed.exitCode).toBe(0);
  const files = listed.stdout
    .toString()
    .split("\n")
    .filter((file) => /\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(file))
    .filter((file) => !file.startsWith("packages/sandbox/src/"));
  const offenders: string[] = [];
  for (const file of files) {
    const handle = Bun.file(join(ROOT, file));
    if ((await handle.exists()) && IMPORTS_SDK.test(await handle.text())) offenders.push(file);
  }
  expect(offenders.filter((file) => !PENDING_IMAGE_TRACK.includes(file))).toEqual([]);
  expect(offenders.filter((file) => PENDING_IMAGE_TRACK.includes(file)).sort()).toEqual(
    [...PENDING_IMAGE_TRACK].sort(),
  );
});

interface Uses {
  used: string[];
  violations: string[];
}

/** Every member read off the SDK's Sandbox class or a Sandbox value in `path`. */
function sandboxUses(path: string, text?: string): Uses {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  if (text !== undefined) {
    const { getSourceFile, fileExists, readFile } = host;
    host.getSourceFile = (name, language, ...rest) =>
      name === path
        ? ts.createSourceFile(name, text, language)
        : getSourceFile.call(host, name, language, ...rest);
    host.fileExists = (name) => name === path || fileExists.call(host, name);
    host.readFile = (name) => (name === path ? text : readFile.call(host, name));
  }
  const program = ts.createProgram([path], options, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path)!;

  const resolve = (symbol: ts.Symbol | undefined) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const isSdkSandbox = (symbol: ts.Symbol | undefined) =>
    symbol?.getName() === "Sandbox" &&
    (symbol.declarations ?? []).some(
      (declaration) =>
        ts.isClassDeclaration(declaration) &&
        declaration.getSourceFile().fileName.includes("@vercel/sandbox"),
    );
  const isInstance = (type: ts.Type): boolean =>
    type.isIntersection() || type.isUnion()
      ? type.types.some(isInstance)
      : isSdkSandbox(type.getSymbol());

  const uses: Uses = { used: [], violations: [] };
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : "<computed>";
      const receiver = node.expression;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const value = resolve(checker.getSymbolAtLocation(receiver));
      if (isSdkSandbox(value) && value!.flags & ts.SymbolFlags.Class) {
        uses.used.push(`Sandbox.${member}`);
        if (!STATIC_ALLOWED.has(member)) uses.violations.push(`${line}: Sandbox.${member}`);
      } else if (isInstance(checker.getTypeAtLocation(receiver))) {
        uses.used.push(`sandbox.${member}`);
        if (!INSTANCE_ALLOWED.has(member)) uses.violations.push(`${line}: <Sandbox>.${member}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

test("vercel.ts uses only calls that never resume on a Sandbox", () => {
  const { used, violations } = sandboxUses(VERCEL_TS);
  // The checker resolved the SDK: it saw the static calls and the instance uses.
  for (const expected of [
    "Sandbox.get",
    "Sandbox.create",
    "Sandbox.getOrCreate",
    "Sandbox.list",
    "sandbox.currentSession",
    "sandbox.update",
    "sandbox.delete",
    "sandbox.domain",
    "sandbox.image",
  ]) {
    expect(used).toContain(expected);
  }
  expect(violations).toEqual([]);
}, 120_000);

test("the check catches resuming calls under any name, and passes Session calls", () => {
  const probe = join(import.meta.dir, "surface-probe.ts");
  const { violations } = sandboxUses(
    probe,
    `import { Sandbox as Box } from "@vercel/sandbox";
export async function probe() {
  const anything = await Box.get({ name: "x" });
  await anything.runCommand("true");
  await anything.extendTimeout(1);
  await anything["snapshot"]();
  await Box.fork({ sourceSandbox: "x" });
  const session = anything.currentSession();
  await session.runCommand("true");
  await session.extendTimeout(1);
}
`,
  );
  expect(violations).toEqual([
    "4: <Sandbox>.runCommand",
    "5: <Sandbox>.extendTimeout",
    "6: <Sandbox>.snapshot",
    "7: Sandbox.fork",
  ]);
}, 120_000);
