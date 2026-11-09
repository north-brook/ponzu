import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import {
  compareVersions,
  extractNotes,
  phoneOnly,
  releases,
  WHAT_TO_TEST_LIMIT,
  whatToTest,
} from "./release-notes";

test("a description's release note section becomes one note per bullet", () => {
  expect(
    extractNotes(
      [
        "## What",
        "",
        "Detail.",
        "",
        "## Release note",
        "",
        "- Comments show who replied.",
        "- pages can be",
        "  renamed by double-clicking.",
        "",
        "## Testing",
        "",
        "- Not a note.",
      ].join("\n"),
    ),
  ).toEqual(["Comments show who replied.", "Pages can be renamed by double-clicking."]);
});

test("a note ends at a sign-off or the trailers git adds", () => {
  expect(
    extractNotes(
      "### Release notes\n\nZoom keeps its place.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ),
  ).toEqual(["Zoom keeps its place."]);
  expect(
    extractNotes(
      "## Release note\n\n- Export keeps fonts.\nCo-Authored-By: Someone <someone@example.com>",
    ),
  ).toEqual(["Export keeps fonts."]);
});

test("the Mac's notes leave out the iPhone's and drop their own label", () => {
  expect(
    extractNotes(
      [
        "## Release note",
        "",
        "- Mac: pair an iPhone from the Ponzu menu.",
        "- iPhone: find the Macs on your Wi-Fi.",
        "- IPHONE: comment by voice.",
        "- Comments show who replied.",
      ].join("\n"),
    ),
  ).toEqual(["Pair an iPhone from the Ponzu menu.", "Comments show who replied."]);
  expect(extractNotes("## Release note\n\niPhone: scan the code on your Mac.")).toEqual([]);
});

test("the iPhone's notes keep its own and drop the Mac's", () => {
  const message = [
    "## Release note",
    "",
    "- Mac: pair an iPhone from the Ponzu menu.",
    "- iPhone: find the Macs on your Wi-Fi.",
    "- Comments show who replied.",
  ].join("\n");
  expect(extractNotes(message, "iphone")).toEqual([
    "Find the Macs on your Wi-Fi.",
    "Comments show who replied.",
  ]);
  // A note without a label is the desktop's when its commit changed more than the phone.
  expect(extractNotes(message, "iphone", false)).toEqual(["Find the Macs on your Wi-Fi."]);
});

test("What to Test is one line per note, within Apple's limit", () => {
  expect(whatToTest(["Send takes one tap.", "Pins stay put."])).toBe(
    "- Send takes one tap.\n- Pins stay put.",
  );
  expect(whatToTest([])).toBe("");
  const long = "x".repeat(1500);
  const text = whatToTest([long, long, long]);
  expect(text.length).toBeLessThanOrEqual(WHAT_TO_TEST_LIMIT);
  expect(text.split("\n")).toHaveLength(2);
});

test("a labelled line starts its own note without a bullet", () => {
  expect(
    extractNotes(
      [
        "## Release note",
        "",
        "Mac: designs that changed show a dot.",
        "iPhone: the Activity tab is gone.",
      ].join("\n"),
    ),
  ).toEqual(["Designs that changed show a dot."]);
  expect(
    extractNotes(
      [
        "## Release note",
        "",
        "- Comments pinned on the",
        "  iPhone: show on the Mac too.",
        "- Export keeps the",
        "  Mac: fonts it found.",
      ].join("\n"),
    ),
  ).toEqual([
    "Comments pinned on the iPhone: show on the Mac too.",
    "Export keeps the Mac: fonts it found.",
  ]);
});

test("no section, an empty one, or none says nothing", () => {
  expect(extractNotes("fix: a thing\n\nNo notes here.")).toEqual([]);
  expect(extractNotes("## Release note\n\n<!-- one line per change -->\n")).toEqual([]);
  expect(extractNotes("## Release note\n\nNone.")).toEqual([]);
  expect(extractNotes("## Release note\n\n- n/a")).toEqual([]);
});

test("a commit that changed only the phone app is not the Mac's", () => {
  expect(phoneOnly(["apps/mobile/app/index.tsx", "apps/mobile/app.json"])).toBe(true);
  expect(phoneOnly(["apps/mobile/app/index.tsx", "packages/core/src/doc.ts"])).toBe(false);
  expect(phoneOnly([])).toBe(false);
});

test("versions order by number, not text", () => {
  expect(["0.10.0", "0.2.0", "1.0.0", "0.2.1"].sort(compareVersions)).toEqual([
    "0.2.0",
    "0.2.1",
    "0.10.0",
    "1.0.0",
  ]);
});

test("each release carries the Mac's notes merged since the tag before it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
  try {
    const git = (...args: string[]) =>
      $`git -c user.name=t -c user.email=t@example.com -c tag.gpgsign=false -c commit.gpgsign=false ${args}`
        .cwd(dir)
        .quiet();
    // A commit that changes `file`, if given, or nothing.
    const commit = async (subject: string, note?: string, file?: string) => {
      if (file) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), subject);
        await git("add", file);
      }
      const message = note ? `${subject}\n\n## Release note\n\n- ${note}` : subject;
      await git("commit", "-q", "--allow-empty", "-m", message);
    };
    await git("init", "-q", "-b", "main");
    await commit("feat: an open canvas", "Open a design.");
    await git("tag", "v0.1.0");
    await commit("ci: faster checks");
    await commit("fix: comments stay put", "Comments stay where you left them.");
    await commit("feat: page icons", "Pages show their icons.", "apps/studio/icons.ts");
    await commit("feat: scan the code", "Scan the code to pair.", "apps/mobile/app/scan.tsx");
    await commit("chore(main): release 0.2.0", "Not a note.");
    await git("tag", "v0.2.0");
    await commit("feat: not shipped yet", "Unreleased.");
    expect(await releases(dir)).toEqual([
      {
        version: "0.2.0",
        notes: ["Comments stay where you left them.", "Pages show their icons."],
      },
      { version: "0.1.0", notes: ["Open a design."] },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each phone release carries its notes merged since the phone's tag before it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
  try {
    const git = (...args: string[]) =>
      $`git -c user.name=t -c user.email=t@example.com -c tag.gpgsign=false -c commit.gpgsign=false ${args}`
        .cwd(dir)
        .quiet();
    const commit = async (subject: string, note: string | undefined, ...files: string[]) => {
      for (const file of files) {
        await mkdir(dirname(join(dir, file)), { recursive: true });
        await writeFile(join(dir, file), subject);
        await git("add", file);
      }
      const message = note ? `${subject}\n\n## Release note\n\n${note}` : subject;
      await git("commit", "-q", "--allow-empty", "-m", message);
    };
    await git("init", "-q", "-b", "main");
    await commit("feat(mobile): a canvas", "- Open a design.", "apps/mobile/app/index.tsx");
    await git("tag", "mobile-v0.1.0");
    await commit("fix(mobile): one-tap send", "- Send takes one tap.", "apps/mobile/app/send.tsx");
    await commit("feat: page icons", "- Pages show their icons.", "apps/studio/icons.ts");
    await git("tag", "v1.0.0");
    await commit(
      "fix: pins stay on their node",
      "- Mac: Pins stay put on the Mac.\n- iPhone: Pins stay put.",
      "packages/core/doc.ts",
      "apps/mobile/app/pins.tsx",
    );
    await commit("chore(main): release mobile 0.2.0", "- Not a note.", "apps/mobile/app.json");
    await git("tag", "mobile-v0.2.0");
    await commit("fix(mobile): not shipped yet", "- Unreleased.", "apps/mobile/app/later.tsx");
    expect(await releases(dir, "iphone")).toEqual([
      { version: "0.2.0", notes: ["Send takes one tap.", "Pins stay put."] },
      { version: "0.1.0", notes: ["Open a design."] },
    ]);
    // The phone's tags never become the desktop's releases.
    expect(await releases(dir)).toEqual([{ version: "1.0.0", notes: ["Pages show their icons."] }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
