/*
 * A shadcn/ui component arrives naming shadcn's theme (`bg-popover`, `text-muted-foreground`,
 * `rounded-md`, `shadow-md`) and tw-animate-css's motion. cloud.css clears Tailwind's palette,
 * radii and shadows, so those paint nothing here: each must be mapped onto our tokens by hand
 * (src/cloud/README.md, "Adding a component"). This keeps one from being left behind.
 */
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { unmappedClasses } from "../../../scripts/shadcn-names.ts";

const CLOUD = join(import.meta.dir, "..");

test("no class in the cloud UI names shadcn's theme instead of our tokens", async () => {
  const found: string[] = [];
  for (const file of readdirSync(CLOUD, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) || file.startsWith("gallery/"))
      continue;
    for (const { line, name } of unmappedClasses(await Bun.file(join(CLOUD, file)).text())) {
      found.push(`${file}:${line} ${name}`);
    }
  }
  expect(found).toEqual([]);
});

test("the check knows shadcn's names from ours", () => {
  const names = (source: string) => unmappedClasses(source).map((f) => f.name);
  expect(
    names(
      '"bg-popover text-popover-foreground rounded-md shadow-md focus:bg-accent text-muted-foreground bg-muted data-[state=open]:animate-in ring-[3px] text-sm bg-black/50"',
    ),
  ).toEqual([
    "bg-popover",
    "text-popover-foreground",
    "rounded-md",
    "shadow-md",
    "bg-accent",
    "text-muted-foreground",
    "bg-muted",
    "animate-in",
    "ring-[3px]",
    "text-sm",
    "bg-black/50",
  ]);
  expect(
    names(
      '"bg-surface text-ink rounded-12 shadow-pop data-[highlighted]:bg-hover text-muted border-rule bg-dim text-13 focus-ring"',
    ),
  ).toEqual([]);
});
