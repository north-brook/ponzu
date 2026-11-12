import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Applied,
  binaryOf,
  changelogBetween,
  claudeUrl,
  compareVersions,
  discover,
  type Manifest,
  modelsNotOffered,
  type Packument,
  pairOf,
  pullRequest,
  type RunResults,
  signatureProblem,
  verifySignature,
} from "./bump.ts";

// Recorded on 2026-11-11 from registry.npmjs.org (trimmed to four versions), from
// downloads.claude.ai (2.1.322's manifest.json, its .sig and the signing key, as served), from
// the two CHANGELOG.md files on GitHub (each section cut to its first five lines), and gpg's
// status lines verifying that manifest with that key.
const FIXTURES = join(import.meta.dir, "fixtures", "bump");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const packument = JSON.parse(fixture("sdk-packument.json")) as Packument;
const manifest = JSON.parse(fixture("manifest-2.1.322.json")) as Manifest;

describe("versions", () => {
  test("order by number, not by text, and refuse what is not x.y.z", () => {
    expect(compareVersions("2.1.322", "2.1.99")).toBe(1);
    expect(compareVersions("0.3.321", "0.3.322")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareVersions("2.1.322-beta", "2.1.322")).toThrow("not an x.y.z version");
  });

  test("an SDK version pairs with the Claude Code its package names", () => {
    expect(pairOf(packument, "0.3.322")).toEqual({ sdk: "0.3.322", claude: "2.1.322" });
    expect(() => pairOf(packument, "0.3.320")).toThrow(
      "the registry names no claudeCodeVersion for @anthropic-ai/claude-agent-sdk@0.3.320",
    );
  });

  test("a pair whose patch numbers differ is refused, naming both, not guessed", () => {
    const drifted: Packument = {
      ...packument,
      versions: { "0.4.0": { version: "0.4.0", claudeCodeVersion: "2.2.5" } },
    };
    expect(() => pairOf(drifted, "0.4.0")).toThrow(
      "@anthropic-ai/claude-agent-sdk@0.4.0 names Claude Code 2.2.5: their patch numbers no longer match",
    );
  });

  test("a version that is not digits and dots is refused before it reaches an output or a URL", () => {
    const odd: Packument = {
      ...packument,
      versions: { "0.4.7": { version: "0.4.7", claudeCodeVersion: "x\ngo=true.1.7" } },
    };
    expect(() => pairOf(odd, "0.4.7")).toThrow(
      '@anthropic-ai/claude-agent-sdk@0.4.7 names Claude Code "x\\ngo=true.1.7": not x.y.z',
    );
  });

  test("a deprecated latest is not proposed, and the note says why", () => {
    const withdrawn: Packument = {
      "dist-tags": { latest: "0.3.323" },
      versions: {
        "0.3.323": { version: "0.3.323", claudeCodeVersion: "2.1.323", deprecated: "broken" },
      },
    };
    const d = discover({ sdk: "0.3.322", claude: "2.1.322" }, withdrawn, null);
    expect(d.bump).toBe(false);
    expect(d.notes).toEqual([
      'The registry\'s latest Agent SDK 0.3.323 is deprecated ("broken"); nothing moves.',
    ]);
  });

  test("one version behind moves both pins to the registry's latest pair", () => {
    const d = discover({ sdk: "0.3.321", claude: "2.1.321" }, packument, "2.1.322");
    expect(d.bump).toBe(true);
    expect(d.latest).toEqual({ sdk: "0.3.322", claude: "2.1.322" });
    expect(d.notes).toEqual(["Agent SDK 0.3.321 → 0.3.322 and Claude Code 2.1.321 → 2.1.322."]);
  });

  test("current pins, or newer ones, move nowhere", () => {
    expect(discover({ sdk: "0.3.322", claude: "2.1.322" }, packument, "2.1.322").bump).toBe(false);
    const ahead = discover({ sdk: "0.3.330", claude: "2.1.330" }, packument, null);
    expect(ahead.bump).toBe(false);
    expect(ahead.notes[0]).toBe(
      "The pinned Agent SDK 0.3.330 is newer than the registry's latest 0.3.322; nothing moves back.",
    );
  });

  test("a Claude Code with no SDK yet is said, and the newest pair is still the target", () => {
    const d = discover({ sdk: "0.3.321", claude: "2.1.321" }, packument, "2.1.323");
    expect(d.latest.claude).toBe("2.1.322");
    expect(d.notes[1]).toBe(
      "Claude Code 2.1.323 is out, but no Agent SDK names it yet; 2.1.322 is the newest pair.",
    );
  });
});

describe("the signed manifest", () => {
  test("gives the linux-x64 binary's hash and size, only for the version asked", () => {
    expect(binaryOf(manifest, "2.1.322")).toEqual({
      sha256: "bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478",
      size: 341914128,
    });
    expect(() => binaryOf(manifest, "2.1.321")).toThrow(
      "the manifest for 2.1.321 says it is 2.1.322",
    );
    expect(claudeUrl("2.1.322")).toBe(
      "https://downloads.claude.ai/claude-code-releases/2.1.322/linux-x64/claude",
    );
  });

  test("gpg's status for the recorded signature passes; another signer or a bad one does not", () => {
    const status = fixture("gpg-status.txt");
    expect(signatureProblem(status)).toBeNull();
    expect(signatureProblem(status, "0".repeat(40))).toBe(
      `signed by 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE, not ${"0".repeat(40)}`,
    );
    expect(signatureProblem(status.replace("GOODSIG", "BADSIG"))).toBe("gpg said BADSIG");
    expect(signatureProblem("")).toBe("gpg found no good signature");
  });

  test.skipIf(!Bun.which("gpg"))(
    "gpg verifies the recorded manifest with the recorded key, and refuses it changed by one hash",
    () => {
      const key = join(FIXTURES, "claude-code.asc");
      const sig = join(FIXTURES, "manifest-2.1.322.json.sig");
      expect(verifySignature(key, join(FIXTURES, "manifest-2.1.322.json"), sig)).toBeNull();
      const dir = mkdtempSync(join(tmpdir(), "ponzu-bump-test-"));
      try {
        const tampered = join(dir, "manifest.json");
        writeFileSync(
          tampered,
          fixture("manifest-2.1.322.json").replace(
            "bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478",
            "0".repeat(64),
          ),
        );
        expect(verifySignature(key, tampered, sig)).toBe("gpg said BADSIG");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("release notes", () => {
  test("the sections after the pinned version, up to the new one", () => {
    const claude = changelogBetween(fixture("claude-code-changelog.md"), "2.1.319", "2.1.322");
    expect(claude.map((s) => s.version)).toEqual(["2.1.322", "2.1.321"]);
    expect(claude[0]!.body).toBe(
      "- Added fast mode on Vertex in the global, us and eu regions, falling back to standard speed if Vertex refuses it",
    );
    const sdk = changelogBetween(fixture("agent-sdk-changelog.md"), "0.3.321", "0.3.322");
    expect(sdk).toEqual([
      { version: "0.3.322", body: "- Updated to parity with Claude Code v2.1.322" },
    ]);
  });

  test("names the models the notes mention that Ponzu does not offer", () => {
    const notes = changelogBetween(fixture("claude-code-changelog.md"), "2.1.320", "2.1.321")[0]!;
    expect(modelsNotOffered(notes.body)).toEqual([]);
    expect(modelsNotOffered(notes.body, ["claude-opus-5-5"])).toEqual(["claude-fable-5-2"]);
    expect(modelsNotOffered("see claude-code-releases and claude-code 2.1")).toEqual([]);
  });
});

describe("the pull request", () => {
  const applied: Applied = {
    discovery: discover({ sdk: "0.3.321", claude: "2.1.321" }, packument, "2.1.322"),
    pins: {
      claudeVersion: "2.1.322",
      claudeUrl: claudeUrl("2.1.322"),
      claudeSha256: "bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478",
    },
    size: 341914128,
    changelog: { claude: [{ version: "2.1.322", body: "- a note" }], sdk: [] },
    modelsNotOffered: ["claude-new-6"],
  };
  const passed: RunResults = {
    applied,
    typecheck: { outcome: "success", log: "" },
    tests: { outcome: "success", log: "" },
    image: { result: "built", reason: "", log: "", image: `ponzu-runner@sha256:${"c".repeat(64)}` },
    turn: { outcome: "success", reason: "", log: "" },
    runUrl: "https://github.com/north-brook/ponzu/actions/runs/1",
  };

  test("all passing is ready for review, and says what it moved and what to add", () => {
    const pr = pullRequest(passed);
    expect(pr.draft).toBe(false);
    expect(pr.failed).toBe(false);
    expect(pr.body.split("\n")[0]).toBe(
      "Everything below passed. Review the release notes, then merge.",
    );
    expect(pr.body).toContain(
      "Agent SDK from 0.3.321 to **0.3.322** and Claude Code from 2.1.321 to **2.1.322**",
    );
    expect(pr.body).toContain("`claude-new-6`");
  });

  test("a failing turn is a draft that says so first", () => {
    const pr = pullRequest({
      ...passed,
      turn: { outcome: "failure", reason: "", log: "timed out" },
    });
    expect(pr.draft).toBe(true);
    expect(pr.failed).toBe(true);
    expect(pr.body.split("\n")[0]).toBe(
      "**This is a draft because the real turn failed.** Do not merge it until a run passes.",
    );
    expect(pr.body).toContain("<details><summary>Turn log (the end)</summary>");
  });

  test("a typecheck failure is told apart from a failing check in the image", () => {
    const typecheck = pullRequest({
      ...passed,
      typecheck: { outcome: "failure", log: "sdk.ts(130,9): error TS2353" },
    });
    expect(typecheck.body).toContain("| Typecheck | **fails**: the new SDK's types no longer fit");
    const check = pullRequest({
      ...passed,
      image: {
        result: "failed",
        reason: "",
        image: "",
        log: "  FAIL the runner's turn through the fake API\ncheck failed: the runner's turn through the fake API\n",
      },
      turn: { outcome: "skipped", reason: "", log: "" },
    });
    expect(check.body).toContain(`**fails** at the check "the runner's turn through the fake API"`);
    expect(check.body).toContain("| Typecheck | passes with the new SDK's types |");
  });

  test("setup that is missing makes a draft that is not a failure, and says why", () => {
    const pr = pullRequest({
      ...passed,
      image: { result: "skipped", reason: "VERCEL_TOKEN is not set", log: "", image: "" },
      turn: { outcome: "skipped", reason: "ANTHROPIC_API_KEY is not set", log: "" },
    });
    expect(pr.draft).toBe(true);
    expect(pr.failed).toBe(false);
    expect(pr.body).toContain("not built: VERCEL_TOKEN is not set");
    expect(pr.body).toContain("not run: ANTHROPIC_API_KEY is not set");
  });
});
