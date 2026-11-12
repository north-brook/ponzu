// Lines kept word for word in S3 (apps/runner, packages/tools, core, evals, render)'s files. Owned by that slice. Each entry: a path glob,
// a substring of the line, and why. Keep `has` specific: it allows only lines that contain it.
import type { Keep } from "../canvas-words.ts";

export const KEEP_AGENT: Keep[] = [
  { path: "packages/core/src/doc.ts", has: ".design in memory", why: "the 1.x file" },
  {
    path: "packages/core/src/doc.ts",
    has: "a sample design the home screen",
    why: "the 1.x home screen",
  },
  { path: "packages/core/src/replica.test.ts", has: '"design.system"', why: "a note's name" },
  { path: "apps/runner/image/README.md", has: "environment by design", why: "the idiom" },
  { path: "apps/runner/src/run.ts", has: "quiet by design", why: "the idiom" },
  { path: "packages/render/src/lint.test.ts", has: "wrap by design", why: "the idiom" },
];
