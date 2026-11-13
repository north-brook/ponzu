import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../.release-please-manifest.json" with { type: "json" };
import { verdict } from "./release-hold";

const MANIFEST = { ".": "1.80.1", "apps/mobile": "0.12.1" };

const answer = (app: "ponzu" | "mobile", title: string, releasesHeld?: string) =>
  verdict({ app, title, releasesHeld, manifest: MANIFEST });

describe("release holds", () => {
  test("a major release is held for a person", () => {
    expect(answer("ponzu", "chore(main): release 2.0.0")).toEqual({
      hold: true,
      why: "2.0.0 is a major release over 1.80.1; a person merges it",
    });
    expect(answer("mobile", "chore(main): release mobile 1.0.0").hold).toBe(true);
  });

  test("a minor or patch release merges", () => {
    expect(answer("ponzu", "chore(main): release 1.81.0")).toEqual({ hold: false });
    expect(answer("ponzu", "chore(main): release 1.80.2")).toEqual({ hold: false });
    // Breaking at 0.x is a minor bump (bump-minor-pre-major); RELEASES_HELD holds it.
    expect(answer("mobile", "chore(main): release mobile 0.13.0")).toEqual({ hold: false });
  });

  test("RELEASES_HELD holds only the apps it names", () => {
    expect(answer("mobile", "chore(main): release mobile 0.12.2", "mobile")).toEqual({
      hold: true,
      why: "RELEASES_HELD names mobile",
    });
    expect(answer("ponzu", "chore(main): release 1.81.0", "mobile")).toEqual({ hold: false });
    expect(answer("ponzu", "chore(main): release 1.81.0", " Ponzu , mobile ").hold).toBe(true);
    expect(answer("mobile", "chore(main): release mobile 0.12.2", "ponzu,mobile").hold).toBe(true);
    expect(answer("ponzu", "chore(main): release 1.81.0", "")).toEqual({ hold: false });
    expect(answer("ponzu", "chore(main): release 1.81.0", " , ")).toEqual({ hold: false });
  });

  test("a name in RELEASES_HELD that is no app holds every app", () => {
    for (const held of ["all", "desktop", "ponzu-desktop", "constructor", "mobile,mac"])
      expect(answer("ponzu", "chore(main): release 1.81.0", held).hold).toBe(true);
  });

  test("a title that is not the app's release title holds (the safe side)", () => {
    for (const title of [
      "",
      "release 1.81.0",
      "chore(main): release v1.81.0",
      "chore(main): release 1.81",
      "chore(main): release 1.81.0-beta.1",
      "chore(main): release 1.81.0 ",
      "chore(main): release 01.81.0x",
      "chore(main): release 01.81.0",
      " chore(main): release 1.81.0",
      "chore(main): release mobile 0.12.2",
      "chore(main)!: release 1.81.0",
      "chore(cloud): release 1.81.0",
      "chore(main): release 1.81.0\nchore(main): release 1.81.0",
    ])
      expect(answer("ponzu", title).hold).toBe(true);
    expect(answer("mobile", "chore(main): release 0.12.2").hold).toBe(true);
  });

  test("a version that is not newer than the manifest's holds", () => {
    expect(answer("ponzu", "chore(main): release 1.80.1")).toEqual({
      hold: true,
      why: "1.80.1 is not newer than 1.80.1, the version released now",
    });
    expect(answer("ponzu", "chore(main): release 1.79.9").hold).toBe(true);
    expect(answer("ponzu", "chore(main): release 0.99.0").hold).toBe(true);
  });

  test("the pull request's own manifest must give the title's version", () => {
    const title = "chore(main): release 1.81.0";
    const check = (proposed: Record<string, unknown> | null) =>
      verdict({ app: "ponzu", title, manifest: MANIFEST, proposed });
    expect(check({ ".": "1.81.0", "apps/mobile": "0.12.1" })).toEqual({ hold: false });
    // A 2.0.0 release PR retitled as a minor one is still held.
    expect(check({ ".": "2.0.0", "apps/mobile": "0.12.1" })).toEqual({
      hold: true,
      why: `the pull request's manifest gives ponzu "2.0.0", not 1.81.0`,
    });
    expect(check({ "apps/mobile": "0.12.1" }).hold).toBe(true);
    expect(check({ ".": 1.81 }).hold).toBe(true);
    expect(check(null).hold).toBe(true);
  });

  test("an app missing from the manifest holds", () => {
    expect(
      verdict({ app: "mobile", title: "chore(main): release mobile 0.12.2", manifest: {} }).hold,
    ).toBe(true);
  });

  test("reads the repository's manifest when none is given", () => {
    const [major, minor] = (manifest as Record<string, string>)["."]?.split(".") ?? [];
    expect(
      verdict({ app: "ponzu", title: `chore(main): release ${major}.${Number(minor) + 1}.0` }),
    ).toEqual({ hold: false });
    expect(
      verdict({ app: "ponzu", title: `chore(main): release ${Number(major) + 1}.0.0` }).hold,
    ).toBe(true);
  });
});

describe("the command", () => {
  // Awaited, never spawnSync, which can lose the child's exit in a `bun test --parallel` worker.
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn(["bun", join(import.meta.dir, "release-hold.ts"), ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, out: out.trim() };
  };

  test("prints merge or hold, reading RELEASES_HELD from its environment", async () => {
    // The next patch after whatever is released now: a fixed version here goes stale, and
    // fails, the moment a release passes it.
    const [major, minor, patch] = (manifest as Record<string, string>)["."]?.split(".") ?? [];
    const title = `chore(main): release ${major}.${minor}.${Number(patch) + 1}`;
    expect(await run(["--app", "ponzu", "--title", title])).toEqual({ code: 0, out: "merge" });
    expect(await run(["--app", "ponzu", "--title", title], { RELEASES_HELD: "ponzu" })).toEqual({
      code: 0,
      out: "hold: RELEASES_HELD names ponzu",
    });
  });

  test("reads the pull request's manifest from --proposed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "release-hold-"));
    const [major, minor] = (manifest as Record<string, string>)["."]?.split(".") ?? [];
    const next = `${major}.${Number(minor) + 1}.0`;
    const file = join(dir, "proposed.json");
    writeFileSync(file, JSON.stringify({ ".": next }));
    const args = ["--app", "ponzu", "--title", `chore(main): release ${next}`, "--proposed", file];
    expect(await run(args)).toEqual({ code: 0, out: "merge" });
    writeFileSync(file, "Not Found");
    expect((await run(args)).out).toStartWith("hold: the pull request's manifest gives ponzu null");
    expect((await run(args.slice(0, -1))).code).toBe(2);
    rmSync(dir, { recursive: true });
  });

  test("a bad flag answers neither", async () => {
    expect(await run(["--app", "desktop", "--title", "chore(main): release 1.80.2"])).toEqual({
      code: 2,
      out: "",
    });
    expect((await run(["--app", "ponzu"])).code).toBe(2);
  });
});
