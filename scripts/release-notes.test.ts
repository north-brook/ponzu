import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import {
  type Changelog,
  changelog,
  compareVersions,
  extractNotes,
  inMacRelease,
  MAC_EXCLUDED,
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
  // The phone plus a path neither app's release holds is still the phone's.
  expect(phoneOnly(["apps/mobile/app/index.tsx", "apps/api/src/routes/push.ts"])).toBe(true);
  expect(phoneOnly(["apps/api/src/routes/push.ts"])).toBe(false);
  expect(phoneOnly(["apps/mobile-web/x.ts"])).toBe(false);
});

test("the Mac's release leaves out what Release Please leaves out of it", () => {
  expect(MAC_EXCLUDED).toEqual([
    "apps/mobile",
    "apps/api",
    "apps/runner",
    "packages/db",
    "packages/sandbox",
    "packages/evals",
    "packages/email",
    "infra",
    "docs",
  ]);
  for (const file of [
    "apps/mobile/app/index.tsx",
    "apps/api/src/app.ts",
    "apps/runner/src/main.ts",
    "packages/db/migrations/0030_x.sql",
    "packages/sandbox/src/index.ts",
    "packages/evals/src/run.ts",
    "infra/environments.json",
    "docs/cloud.md",
  ])
    expect(inMacRelease([file])).toBe(false);
  expect(inMacRelease(["apps/api/src/app.ts", "docs/cloud.md", "infra/neon.json"])).toBe(false);
  expect(inMacRelease(["apps/api/src/app.ts", "apps/desktop/src/main.ts"])).toBe(true);
  expect(inMacRelease(["packages/client/src/api.ts"])).toBe(true);
  // A name that only starts like an excluded path is not under it.
  expect(inMacRelease(["docs.md", "infrastructure/x"])).toBe(true);
  expect(inMacRelease([])).toBe(true);
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
    await commit("feat(api): faster wakes", "Canvases wake faster.", "apps/api/src/wake.ts");
    await commit("docs: the runbook", "A runbook.", "docs/production.md");
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
    await commit(
      "feat(mobile): pings",
      "- Pings reach the phone.",
      "apps/mobile/lib/push.ts",
      "apps/api/src/routes/devices.ts",
    );
    await commit("chore(main): release mobile 0.2.0", "- Not a note.", "apps/mobile/app.json");
    await git("tag", "mobile-v0.2.0");
    await commit("fix(mobile): not shipped yet", "- Unreleased.", "apps/mobile/app/later.tsx");
    expect(await releases(dir, "iphone")).toEqual([
      {
        version: "0.2.0",
        notes: ["Send takes one tap.", "Pins stay put.", "Pings reach the phone."],
      },
      { version: "0.1.0", notes: ["Open a design."] },
    ]);
    // The phone's tags never become the desktop's releases.
    expect(await releases(dir)).toEqual([{ version: "1.0.0", notes: ["Pages show their icons."] }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SCRIPT = join(import.meta.dir, "release-notes.ts");

/** A repository whose commits carry fixed dates, so each tag's date is known. */
async function datedRepo(dir: string) {
  let date = "";
  const git = (...args: string[]) =>
    $`git -c user.name=t -c user.email=t@example.com -c tag.gpgsign=false -c commit.gpgsign=false ${args}`
      .cwd(dir)
      .env({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
      .quiet();
  const commit = async (when: string, subject: string, note: string, file: string) => {
    date = when;
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), subject);
    await git("add", file);
    await git("commit", "-q", "-m", `${subject}\n\n## Release note\n\n${note}`);
  };
  await git("init", "-q", "-b", "main");
  await commit(
    "2026-11-02T09:00:00-08:00",
    "feat: a canvas",
    "- Open a canvas.",
    "apps/studio/a.ts",
  );
  await git("tag", "v2.0.0");
  await commit(
    "2026-11-03T10:30:00+00:00",
    "feat(mobile): comments",
    "- Comment from your phone.",
    "apps/mobile/app/comments.tsx",
  );
  await git("tag", "mobile-v1.0.0");
  await commit(
    "2026-11-20T18:15:00-05:00",
    "fix: pins stay put",
    "- Mac: Pins stay put.\n- iPhone: Pins stay put on the phone too.",
    "packages/core/doc.ts",
  );
  await git("tag", "v2.1.0");
  await commit(
    "2026-11-21T08:00:00+00:00",
    "feat: not shipped",
    "- Unreleased.",
    "apps/studio/b.ts",
  );
}

test("the changelog dates each app's releases by its tag's commit, newest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
  try {
    await datedRepo(dir);
    expect(await changelog(dir)).toEqual({
      mac: [
        { version: "2.1.0", date: "2026-11-20T18:15:00-05:00", notes: ["Pins stay put."] },
        { version: "2.0.0", date: "2026-11-02T09:00:00-08:00", notes: ["Open a canvas."] },
      ],
      iphone: [
        {
          version: "1.0.0",
          // Git writes a UTC date with Z, as GitHub's release commits have it.
          date: "2026-11-03T10:30:00Z",
          notes: ["Comment from your phone."],
        },
      ],
    } satisfies Changelog);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unpublished release's notes show under the release that shipped them", async () => {
  // As on 2026-11-13: v2.1.1's publish failed and its release stayed a draft;
  // v2.2.0 changed the Mac only with iPhone-labelled notes and shipped 2.1.1's fixes.
  const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
  try {
    await datedRepo(dir);
    let date = "";
    const git = (...args: string[]) =>
      $`git -c user.name=t -c user.email=t@example.com -c tag.gpgsign=false -c commit.gpgsign=false ${args}`
        .cwd(dir)
        .env({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
        .quiet();
    date = "2026-11-21T09:00:00+00:00";
    await git("tag", "v2.1.1");
    await writeFile(join(dir, "apps/studio/c.ts"), "c");
    await git("add", "apps/studio/c.ts");
    await git(
      "commit",
      "-q",
      "-m",
      "feat: chat\n\n## Release note\n\n- iPhone: Chat on the phone.",
    );
    await git("tag", "v2.2.0");
    date = "2026-11-22T09:00:00+00:00";
    await writeFile(join(dir, "apps/studio/d.ts"), "d");
    await git("add", "apps/studio/d.ts");
    await git("commit", "-q", "-m", "fix: later\n\n## Release note\n\n- Tagged, not published.");
    await git("tag", "v2.2.1");

    // Without the drafts named, the tags say 2.1.1 shipped and 2.2.0 had nothing.
    expect((await changelog(dir)).mac.map((r) => r.version)).toEqual([
      "2.2.1",
      "2.1.1",
      "2.1.0",
      "2.0.0",
    ]);
    const { mac } = await changelog(dir, new Set(["v2.1.1", "v2.2.1"]));
    expect(mac).toEqual([
      { version: "2.2.0", date: "2026-11-21T09:00:00Z", notes: ["Unreleased."] },
      { version: "2.1.0", date: "2026-11-20T18:15:00-05:00", notes: ["Pins stay put."] },
      { version: "2.0.0", date: "2026-11-02T09:00:00-08:00", notes: ["Open a canvas."] },
    ]);
    // The update popover's notes (no drafts named) are unchanged.
    expect((await releases(dir)).map((r) => r.version)).toEqual([
      "2.2.1",
      "2.1.1",
      "2.1.0",
      "2.0.0",
    ]);

    const out = join(dir, "changelog.json");
    await $`bun ${SCRIPT} --changelog ${out} --unpublished ${"v2.1.1, v2.2.1"}`.cwd(dir).quiet();
    expect(JSON.parse(await Bun.file(out).text()).mac).toEqual(mac);
    // An empty list, as the workflow passes when there are no drafts, names none.
    await $`bun ${SCRIPT} --changelog ${out} --unpublished ${""}`.cwd(dir).quiet();
    expect(JSON.parse(await Bun.file(out).text())).toEqual(await changelog(dir));
    const wrong = await $`bun ${SCRIPT} --changelog ${out} --drafts v2.1.1`
      .cwd(dir)
      .nothrow()
      .quiet();
    expect(wrong.exitCode).toBe(1);
    const bare = await $`bun ${SCRIPT} --changelog ${out} --unpublished`.cwd(dir).nothrow().quiet();
    expect(bare.exitCode).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--changelog writes the file a release publishes, and marks a shallow clone's incomplete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-notes-"));
  try {
    const repo = join(dir, "repo");
    await mkdir(repo);
    await datedRepo(repo);
    const out = join(dir, "out", "changelog.json");
    await $`bun ${SCRIPT} --changelog ${out}`.cwd(repo).quiet();
    const text = await Bun.file(out).text();
    expect(JSON.parse(text)).toEqual(await changelog(repo));
    expect(text.endsWith("}\n")).toBe(true);

    // CI's checkout without history: empty lists, said to be incomplete, and no failure.
    const shallow = join(dir, "shallow");
    await $`git clone -q --depth 1 ${`file://${repo}`} ${shallow}`.quiet();
    await $`bun ${SCRIPT} --changelog ${out}`.cwd(shallow).quiet();
    expect(JSON.parse(await Bun.file(out).text())).toEqual({
      mac: [],
      iphone: [],
      incomplete: true,
    });

    const usage = await $`bun ${SCRIPT} --changelog`.cwd(repo).nothrow().quiet();
    expect(usage.exitCode).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
