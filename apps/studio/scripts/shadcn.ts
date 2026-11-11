#!/usr/bin/env bun
/**
 * `bun run shadcn add <component…> [--overwrite]`, from apps/studio: the shadcn CLI, then what
 * makes its files ours.
 *
 * components.json sends the files to src/cloud/ui. The registry's files import `cn` from the
 * `cn` package and their siblings through the `#cloud/*` alias; this points them at our own
 * `ui/cn.ts` (which knows the token scales) and at the siblings by relative path, the way the
 * rest of the folder imports, and takes back the dependencies the CLI adds that the cloud UI
 * doesn't use (`cn`, and `lucide-react`: our icons are Hugeicons). Then it lists the classes in
 * the new files that still name shadcn's theme instead of our tokens, to map by hand
 * (src/cloud/README.md has the table).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { unmappedClasses } from "./shadcn-names.ts";

const STUDIO = resolve(import.meta.dir, "..");
const UI = join(STUDIO, "src/cloud/ui");
/** Dependencies the registry asks for that the cloud UI replaces with its own. */
const REFUSED = ["cn", "lucide-react", "tw-animate-css"];

const args = Bun.argv.slice(2);
if (args[0] !== "add" || args.length < 2) {
  console.error("usage: bun run shadcn add <component…> [--overwrite]");
  process.exit(2);
}

const stamp = (dir: string) =>
  new Map(readdirSync(dir).map((f) => [f, statSync(join(dir, f)).mtimeMs] as const));
const before = stamp(UI);
const packageFile = Bun.file(join(STUDIO, "package.json"));
const packageBefore = await packageFile.json();

const cli = Bun.spawn(["bunx", "shadcn@4.23.0", ...args, "--yes"], {
  cwd: STUDIO,
  stdio: ["inherit", "inherit", "inherit"],
});
if ((await cli.exited) !== 0) process.exit(1);

// Take back what the CLI installed that the cloud UI doesn't use.
const packageAfter = await packageFile.json();
const added = REFUSED.filter(
  (dep) => packageAfter.dependencies?.[dep] && !packageBefore.dependencies?.[dep],
);
if (added.length) {
  const remove = Bun.spawn(["bun", "remove", ...added], {
    cwd: STUDIO,
    stdio: ["inherit", "inherit", "inherit"],
  });
  await remove.exited;
}

const changed = [...stamp(UI)]
  .filter(([file, at]) => before.get(file) !== at && /\.tsx?$/.test(file))
  .map(([file]) => join(UI, file));

const sibling = (name: string) =>
  [".tsx", ".ts"].map((ext) => `./${name}${ext}`).find((p) => existsSync(join(UI, p))) ??
  `./${name}.tsx`;

for (const file of changed) {
  let source = await Bun.file(file).text();
  source = source
    .replace(/^["']use client["'];?\n+/, "")
    .replaceAll(/from "cn"/g, 'from "./cn.ts"')
    .replaceAll(/from "#cloud\/ui\/cn(?:\.ts)?"/g, 'from "./cn.ts"')
    .replaceAll(
      /from "#cloud\/ui\/([\w-]+)(?:\.tsx?)?"/g,
      (_, name: string) => `from "${sibling(name)}"`,
    );
  await Bun.write(file, source);
}

if (changed.length) {
  const format = Bun.spawn(["bunx", "biome", "check", "--write", ...changed], {
    cwd: STUDIO,
    stdio: ["inherit", "inherit", "inherit"],
  });
  await format.exited;
}

let todo = 0;
for (const file of changed) {
  const source = await Bun.file(file).text();
  const left = unmappedClasses(source);
  const lucide = source.includes("lucide-react");
  if (!left.length && !lucide) continue;
  console.log(`\n${file.slice(STUDIO.length + 1)}`);
  if (lucide) console.log("  icons from lucide-react: use ui/icon.tsx with a Hugeicons icon");
  for (const { line, name } of left) console.log(`  ${line}: ${name}`);
  todo += left.length + (lucide ? 1 : 0);
}
console.log(
  todo
    ? `\n${todo} to map onto our tokens (src/cloud/README.md, "Adding a component").`
    : "\nNothing left to map.",
);
