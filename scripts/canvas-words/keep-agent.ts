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
  // Eval inputs: what a person really typed. The suite and the judge's labelled turns share them.
  {
    path: "apps/runner/evals/agent/{agent.eval,judge.examples}.ts",
    has: "Design the onboarding flow for the fitness app in this repo, as iPhone screens.",
    why: "an eval input: the request a person typed in the hand-run session (#448)",
  },
  {
    path: "apps/runner/evals/agent/judge.examples.ts",
    has: "Design a pricing page hero for Stillwater",
    why: "an eval input: the request a person typed in the hand-run session (#451)",
  },
  // The labelled turns are verbatim from the hand-run sessions: what the agent really wrote.
  {
    path: "apps/runner/evals/agent/judge.examples.ts",
    has: "the brief as a design note",
    why: "a recorded agent message the thread judge is calibrated on (#448), verbatim",
  },
  {
    path: "apps/runner/evals/agent/judge.examples.ts",
    has: "so this is a design spec for now",
    why: "a recorded agent message the thread judge is calibrated on (#448), verbatim",
  },
  {
    path: "apps/runner/evals/agent/judge.examples.ts",
    has: "the screen images and the design brief.",
    why: "a recorded agent message the thread judge is calibrated on (#448), verbatim",
  },
  {
    path: "apps/runner/evals/agent/judge.examples.ts",
    has: "the Ponzu-hosted repo for this design may need checking",
    why: "a recorded agent message the thread judge is calibrated on (#448), verbatim",
  },
  {
    path: "apps/runner/evals/agent/seeds.ts",
    has: "the design specs.",
    why: "an eval input: the made-up fitness app's own README, in its team's words about their app",
  },
  {
    path: "packages/tools/src/product.ts",
    has: "the way a product designer builds a launch page",
    why: "the product guide casts the agent as a designer judging a launch-page shot: the honest role for visual craft",
  },
  {
    path: "packages/tools/src/tools.test.ts",
    has: "/code/shop/design/app.design",
    why: "a .design file in a repo's design/ folder (the format); the allowance masks app.design first, then misses the folder",
  },
];
