// Lines kept word for word in S4 (studio, desktop, web, client, canvas)'s files. Owned by that slice. Each entry: a path glob,
// a substring of the line, and why. Keep `has` specific: it allows only lines that contain it.
import type { Keep } from "../canvas-words.ts";

export const KEEP_APPS: Keep[] = [
  {
    path: "apps/web/next.config.ts",
    has: "Agents' links to a design on the person's Mac",
    why: "1.x /open",
  },
  {
    path: "apps/studio/src/app/create.tsx",
    has: "(?:design|make|create|build|draw",
    why: "the verbs people type",
  },
  {
    path: "apps/studio/src/app/create.tsx",
    has: '("Design a pricing card',
    why: "an example of what people type",
  },
  { path: "apps/studio/src/app/create.test.ts", has: '"Design ', why: "what people type" },
  {
    path: "apps/studio/src/app/comment-picture.tsx",
    has: "without a picture, by design",
    why: "the idiom",
  },
  {
    path: "apps/studio/src/app/sidebar-data.ts",
    has: "the viewer left out, by design",
    why: "the idiom",
  },
];
