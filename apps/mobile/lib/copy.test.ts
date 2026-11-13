import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKED,
  CLAUDE,
  CREATE,
  EFFORT_LABELS,
  FILTER,
  NEEDS_YOU,
  PINGS,
  PR,
  SEARCH,
  WHERE,
} from "./copy";

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

test("Needs you in the Mac's words", () => {
  const read = (path: string) =>
    readFileSync(join(import.meta.dir, "../../..", path), "utf8").replace(/\s+/g, " ");
  const source = [
    "apps/studio/src/cloud/needs-you/needs-you.tsx",
    "apps/studio/src/app/ask-store.ts",
    "packages/client/src/model/answer.ts",
  ]
    .map(read)
    .join(" ");
  const words = {
    plan: NEEDS_YOU.plan,
    permission: NEEDS_YOU.permission,
    secret: NEEDS_YOU.secret,
    link: NEEDS_YOU.link,
    chooseAny: NEEDS_YOU.chooseAny,
    questionNote: NEEDS_YOU.questionNote,
    planNote: NEEDS_YOU.planNote,
    note: NEEDS_YOU.note,
    secretField: NEEDS_YOU.secretField,
    opened: NEEDS_YOU.opened,
    notNow: NEEDS_YOU.notNow,
    notWeb: NEEDS_YOU.notWeb,
    movedOn: NEEDS_YOU.movedOn,
    failed: NEEDS_YOU.failed,
    offline: NEEDS_YOU.offline,
    // The phone says where Settings › Environments is; the rest is the Mac's.
    secretsFull: NEEDS_YOU.secretsFull.replace(" in Ponzu on your Mac,", ""),
    secretReserved: NEEDS_YOU.secretReserved,
    noRepository: NEEDS_YOU.noRepository,
    // The Mac writes the repo's name into its sentence.
    keptWithRepo: NEEDS_YOU.secretKept("REPO").replace("REPO", `${"$"}{repoName}`),
    keptHere: NEEDS_YOU.secretKept(null),
  };
  for (const [name, said] of Object.entries(words)) {
    expect({ name, found: source.includes(said) }).toEqual({ name, found: true });
  }
});

test("Settings › Notifications in the Mac's words", () => {
  const source = readFileSync(join(SETUP, "../settings/notifications.tsx"), "utf8").replace(
    /\s+/g,
    " ",
  );
  for (const event of PINGS.events) {
    expect(source).toContain(
      `{ key: "${event.key}", title: "${event.title}", line: "${event.line}" }`,
    );
  }
  for (const [name, words] of Object.entries(PINGS.settings)) {
    const found = source.includes(`"${words}"`);
    expect({ name, found }).toEqual({ name, found: true });
  }
});

test("the pull request sheet's button and the tab's words in the Mac's", () => {
  const read = (path: string) =>
    readFileSync(join(import.meta.dir, "../../..", path), "utf8").replace(/\s+/g, " ");
  const chrome = read("apps/studio/src/cloud/window/next-action.tsx");
  for (const [action, label] of Object.entries(PR.actions)) {
    // As the Mac's table has it: `auto_merge: { label: "Auto-merge", …`.
    const found = chrome.includes(`${action}: { label: "${label}"`);
    expect({ action, found }).toEqual({ action, found: true });
  }
  const tab = chrome + read("apps/studio/src/cloud/pr-tab/pull-request-view.tsx");
  for (const [name, said] of Object.entries(PR.mac)) {
    const found =
      tab.includes(`"${said}"`) || tab.includes(` ${said} `) || tab.includes(`>${said}<`);
    expect({ name, found }).toEqual({ name, found: true });
  }
});

test("Search in the Mac's ⌘K's words, where they say the same thing", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../studio/src/cloud/sidebar/search.tsx"),
    "utf8",
  ).replace(/\s+/g, " ");
  const said = {
    failed: `>${SEARCH.failed}<`,
    searching: `>${SEARCH.searching}<`,
    // The Mac writes the query in place: "No results for “{query.trim()}”".
    noResults: `>${SEARCH.noResults("{query.trim()}")}<`,
    canvases: `label="${SEARCH.canvases}"`,
    boards: `label="${SEARCH.boards}"`,
    agent: `AGENT_NAME = "${SEARCH.agent}"`,
    deleted: `DELETED_NAME = "${SEARCH.deleted}"`,
    resolved: `· ${SEARCH.resolved}\``,
    // The Mac's template literals, as written: `Page in ${hit.canvas.name}`.
    pageIn: `\`${SEARCH.pageIn(`$${"{hit.canvas.name}"}`)}\``,
    boardIn: `\`${SEARCH.boardIn(`$${"{hit.canvas.name}"}`)}\``,
  };
  for (const [name, words] of Object.entries(said)) {
    expect({ name, found: source.includes(words) }).toEqual({ name, found: true });
  }
});

test("the filter in the Mac's filter menu's words", () => {
  const read = (file: string) =>
    readFileSync(join(import.meta.dir, "../../studio/src/cloud/sidebar", file), "utf8").replace(
      /\s+/g,
      " ",
    );
  const source = read("filter-menu.tsx") + read("sidebar.tsx");
  for (const [name, words] of Object.entries(FILTER)) {
    // A string in the source, or the words between tags (JSX puts them on their own line).
    const found = [`"${words}"`, `>${words}<`, `> ${words} <`].some((s) => source.includes(s));
    expect({ name, found }).toEqual({ name, found: true });
  }
});
