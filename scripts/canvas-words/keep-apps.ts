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
  {
    path: "{apps/desktop/src/deep-links*.ts,packages/core/src/links*.ts}",
    has: "://design",
    why: "the app link from before the rename, <scheme>://design/<id>, still opens for good (plan 6.5)",
  },
  {
    path: "packages/core/src/links.ts",
    has: 'path[0] === "design"',
    why: "the old app link's first segment, still read (plan 6.5)",
  },
  {
    path: "apps/desktop/src/bridge.ts",
    has: "(`design/<id>`) opens the same way",
    why: "says the old app link still opens (plan 6.5)",
  },
  {
    path: "apps/desktop/README.md",
    has: "`ponzu://design/<id>` opens the",
    why: "says the old app link still opens (plan 6.5)",
  },
  {
    path: "apps/{desktop/src/deep-links,studio/src/cloud/ui/canvas-address}.test.ts",
    has: '"des_7k2m9x4q0c8v5n1t"',
    why: "an id from before the rename: canvases made then keep des_",
  },
  {
    path: "packages/core/src/links.test.ts",
    has: "des_",
    why: "ids from before the rename, read in the old app link: canvases made then keep des_",
  },
  {
    path: "{apps/web/next.config.ts,apps/studio/src/cloud/ui/canvas-address*.ts}",
    has: "/designs/",
    why: "the web link from before the rename, still read and redirected for good (plan 6.5)",
  },
  {
    path: "apps/studio/src/cloud/ui/canvas-address.ts",
    has: "(?:canvases|designs)",
    why: "the address parser reads the old path too (plan 6.5)",
  },
  {
    path: "packages/client/src/model/pull-request*.ts",
    has: "Designed in Ponzu: ",
    why: "the footer on pull requests opened before the rename, still stripped from the tab (plan 6.2)",
  },
  {
    path: "packages/client/src/model/pull-request-map.ts",
    has: "(?:Made|Designed) in Ponzu: ",
    why: "the footer regex reads the new footer and the old one (plan 6.2)",
  },
  {
    path: "apps/studio/src/cloud/styles/cloud.css",
    has: "as design tools draw one",
    why: "third-party design tools and how they draw a ground (plan 6.1)",
  },
  {
    path: "apps/studio/src/app/ui-state.ts",
    has: "designs",
    why: "the window state's key from before the rename, still read so the open canvas comes back",
  },
  {
    path: "apps/studio/src/app/ui-state.test.ts",
    has: "designs",
    why: "the window state saved before the rename, still read",
  },
];
