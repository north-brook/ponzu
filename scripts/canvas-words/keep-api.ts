// Lines kept word for word in S2 (apps/api, packages/sandbox)'s files. Owned by that slice. Each entry: a path glob,
// a substring of the line, and why. Keep `has` specific: it allows only lines that contain it.
import type { Keep } from "../canvas-words.ts";

export const KEEP_API: Keep[] = [
  {
    path: "apps/api/src/{designs,canvases}/branch.ts",
    has: "create design add build",
    why: 'FILLER: people still type "design a …"; canvas is on the next line beside it',
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
  // Ideas as people really type and tap them: "Design the …" is the verb a brief starts with.
  {
    path: "apps/api/src/ideas/gate.ts",
    has: '"Design the sign-in page" ask for work',
    why: "the gate's own example of a safe idea, quoted as a person would type it",
  },
  {
    path: "apps/api/src/ideas/prompt.ts",
    has: '"Design the first-run", "Give new users"',
    why: "a stock opener the writer is told to avoid, quoted as the model wrote it",
  },
  {
    path: "apps/api/evals/ideas/gate.examples.ts",
    has: '"Design the sign-in page for the deploy dashboard"',
    why: "an eval input: an idea the gate must pass, worded as people write them",
  },
  {
    path: "apps/api/evals/ideas/judge.examples.ts",
    has: '"Design a sign-in page that says what the starter gives you"',
    why: "an eval input the recorded calibration grades",
  },
  {
    path: "apps/api/evals/ideas/judge.examples.ts",
    has: '"Design a first screen that shows one thing to do and why it matters"',
    why: "an eval input the recorded calibration grades",
  },
  {
    path: "apps/api/evals/ideas/score.test.ts",
    has: '"Design the order page"',
    why: "an idea as one is shown on a tile, in the scorer's test",
  },
];
