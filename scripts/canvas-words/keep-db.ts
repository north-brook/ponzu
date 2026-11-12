// Lines kept word for word in S1 (packages/db)'s files. Owned by that slice. Each entry: a path glob,
// a substring of the line, and why. Keep `has` specific: it allows only lines that contain it.
import type { Keep } from "../canvas-words.ts";

export const KEEP_DB: Keep[] = [
  {
    path: "packages/db/src/schema/catalog.test.ts",
    has: 'test("no name in the database says design"',
    why: "the test that the old word is gone names it",
  },
  {
    path: "packages/db/src/schema/catalog.test.ts",
    has: "/design/i.test(line)",
    why: "the test that the old word is gone names it",
  },
];
