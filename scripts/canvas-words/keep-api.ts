// Lines kept word for word in S2 (apps/api, packages/sandbox)'s files. Owned by that slice. Each entry: a path glob,
// a substring of the line, and why. Keep `has` specific: it allows only lines that contain it.
import type { Keep } from "../canvas-words.ts";

export const KEEP_API: Keep[] = [
  {
    path: "apps/api/src/{designs,canvases}/branch.ts",
    has: "create design add build",
    why: 'FILLER: people still type "design a …"; S2 adds canvas beside it',
  },
  // Every canvas made before the rename keeps its des_ id: these keep one in the tests.
  {
    path: "apps/api/src/notifications/kinds.test.ts",
    has: 'canvasId: "des_7k2m9x4q0c8v5n1t"',
    why: "an id from before the rename still parses",
  },
  {
    path: "apps/api/src/notifications/kinds.test.ts",
    has: '"question_raised:des_7k2m9x4q0c8v5n1t:',
    why: "an id from before the rename keys its job",
  },
];
