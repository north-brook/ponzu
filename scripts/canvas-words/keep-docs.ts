// Lines kept word for word in S5 (docs, root files, workflows, scripts)'s files. Owned by that slice. Each entry: a path glob,
// a substring of the line, and why. Keep `has` specific: it allows only lines that contain it.
import type { Keep } from "../canvas-words.ts";

export const KEEP_DOCS: Keep[] = [
  {
    path: "plugin/skills/design-brief/SKILL.md",
    has: "Use when asked to design a page, screen, flow or brand from scratch in Ponzu.",
    why: "the request people type to their agent, so the skill is the one it picks",
  },
  {
    path: "plugin/.{claude,codex}-plugin/plugin.json",
    has: '"keywords": ["design", "canvas"',
    why: "a word people search the plugin marketplaces for",
  },
  { path: "AGENTS.md", has: "`.design` files", why: "the .design folders rule" },
  { path: "scripts/ci/scope.ts", has: "(design|examples)", why: "the design/ folder" },
  {
    path: "scripts/ci/scope.test.ts",
    has: "prose, designs and release bookkeeping",
    why: ".design folders",
  },
  { path: ".github/workflows/release.yml", has: "src/designs.ts", why: "1.x Windows cleanup" },
  {
    path: ".github/workflows/release.yml",
    has: "The Ponzu Design type",
    why: "1.x Windows cleanup",
  },
  { path: "scripts/release-notes.test.ts", has: "esign", why: "release-note fixtures" },
  {
    path: "docs/cloud.md",
    has: "the site sends `https://ponzu.design/designs/<id>` on to `/canvases/<id>`",
    why: "the old web address, which the spec says still opens (the web redirect reads it)",
  },
  {
    path: "docs/cloud.md",
    has: "the app reads `ponzu://design/<id>` as `ponzu://canvas/<id>`",
    why: "the old app link, which the spec says still opens (the desktop's deep-link parser reads it)",
  },
  {
    path: "docs/cloud.md",
    has: "Ids are `[A-Za-z0-9_-]{1,64}`. `ponzu://design/<id>`",
    why: "the old app link, which the links grammar in @ponzu/core still reads for good",
  },
];
