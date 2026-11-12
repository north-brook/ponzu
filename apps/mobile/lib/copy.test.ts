import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKED, CLAUDE, CREATE, EFFORT_LABELS, WHERE } from "./copy";

/*
 * The phone's setup says what the Mac's says. The Mac's words live in its JSX, so this reads
 * the studio's source and checks each phone string is written there, as it is here. When the
 * Mac's words change, this fails until the phone's follow.
 */

const SETUP = join(import.meta.dir, "../../studio/src/cloud/setup");
const mac = (file: string) =>
  readFileSync(join(SETUP, file), "utf8")
    // JSX wraps long text over lines; the words are what count.
    .replace(/\s+/g, " ");

test("Where do you build? in the Mac's words", () => {
  const source = mac("where.tsx");
  for (const [name, words] of Object.entries(WHERE)) {
    expect({ name, found: source.includes(words) }).toEqual({ name, found: true });
  }
});

test("New canvas in the Mac's create page's words", () => {
  const create = join(SETUP, "../create");
  const read = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");
  const source = [
    "create-page.tsx",
    "composer.tsx",
    "repo-picker.tsx",
    "model-picker.tsx",
    "../ui/button.tsx",
  ]
    .map((file) => read(join(create, file)))
    .join(" ");
  for (const [name, words] of Object.entries({ ...CREATE, ...EFFORT_LABELS })) {
    // Quoted, as the Mac writes them in its JSX and props, so a word can't pass inside another.
    const quoted = [`"${words}"`, `>${words}<`, `> ${words} <`, `"${words} `, `>${words} `].some(
      (q) => source.includes(q),
    );
    expect({ name, found: quoted }).toEqual({ name, found: true });
  }
});

test("a blocked send in the Mac's words", () => {
  const source = readFileSync(join(SETUP, "../dialogs/account-dialogs.tsx"), "utf8").replace(
    /\s+/g,
    " ",
  );
  for (const [name, words] of Object.entries(BLOCKED)) {
    expect({ name, found: source.includes(words) }).toEqual({ name, found: true });
  }
});

test("Connect Claude in the Mac's words", () => {
  const source = mac("claude-step.tsx") + mac("claude-card.tsx");
  for (const [name, words] of Object.entries(CLAUDE)) {
    expect({ name, found: source.includes(words) }).toEqual({ name, found: true });
  }
});
