import { expect, test } from "bun:test";
import { emptyDoc, parseHtml } from "@ponzu/core";
import { stepLabel, stepWeight } from "./steps.ts";

const doc = emptyDoc("Fern");
doc.pages.push({
  id: "pg_1",
  name: "Home",
  artboards: [
    {
      id: "ab_b",
      name: "Pricing · B",
      x: 0,
      y: 0,
      root: {
        kind: "el",
        id: "ab_b",
        tag: "section",
        name: "Pricing · B",
        attrs: {},
        style: {},
        children: parseHtml(`<h1 data-id="n_h">Plans</h1>`).nodes,
      },
    },
  ],
});

const label = (name: string, input: Record<string, unknown> = {}) => stepLabel(name, input, doc);

test("canvas steps name the artboard they are on", () => {
  expect(label("mcp__ponzu__write_html", { target: "ab_b", html: "" })).toBe(
    'Drawing "Pricing · B"',
  );
  expect(label("mcp__ponzu__update_styles", { updates: [{ ids: ["n_h"], style: {} }] })).toBe(
    'Drawing "Pricing · B"',
  );
  expect(label("mcp__ponzu__screenshot", { id: "n_h" })).toBe('Looking at "Pricing · B"');
  expect(label("mcp__ponzu__create_artboard", { name: "Pricing · C" })).toBe(
    'Drawing "Pricing · C"',
  );
  expect(label("mcp__ponzu__write_html", { target: "n_gone" })).toBe("Drawing on the canvas");
  expect(label("mcp__ponzu__get_tree")).toBe("Reading the canvas");
  expect(label("mcp__ponzu__set_status", { status: "tightening the hero" })).toBe(
    "Tightening the hero",
  );
});

test("code steps say what they are for, never the command", () => {
  expect(label("Read", { file_path: "/w/src/a.ts" })).toBe("Reading the repo");
  expect(label("Edit", { file_path: "/w/src/Hero.tsx" })).toBe("Editing Hero.tsx");
  expect(label("Bash", { command: "pnpm install --frozen-lockfile" })).toBe(
    "Installing dependencies",
  );
  expect(label("Bash", { command: "bun run dev --port 3000 &" })).toBe("Running the dev server");
  expect(label("Bash", { command: "npx vitest run" })).toBe("Running the tests");
  expect(label("Bash", { command: 'git commit -m "Hero"' })).toBe("Committing");
  expect(label("Bash", { command: "git push" })).toBe("Pushing the branch");
  expect(label("Bash", { command: "ls -la src" })).toBe("Reading the repo");
  expect(label("Bash", { command: "./scripts/seed.sh", description: "Seed the database" })).toBe(
    "Seed the database",
  );
  expect(label("Bash", { command: "./x" })).toBe("Running a command");
  expect(label("WebFetch", { url: "https://tailwindcss.com/docs" })).toBe(
    "Reading tailwindcss.com",
  );
  expect(label("Unknown")).toBe("Working");
});

test("a stretch is named by what it made over what it ran over what it read", () => {
  expect(stepWeight("mcp__ponzu__write_html")).toBe(2);
  expect(stepWeight("mcp__ponzu__create_artboard")).toBe(2);
  expect(stepWeight("Edit")).toBe(2);
  expect(stepWeight("Bash")).toBe(1);
  expect(stepWeight("mcp__ponzu__reply")).toBe(1);
  expect(stepWeight("mcp__ponzu__list_comments")).toBe(0);
  expect(stepWeight("mcp__ponzu__screenshot")).toBe(0);
  expect(stepWeight("Read")).toBe(0);
});
