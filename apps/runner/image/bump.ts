#!/usr/bin/env bun
/**
 * Moves the Agent SDK pin (apps/runner/package.json, bun.lock) and the Claude Code pin
 * (pins.json: version, URL, sha256) together, to the newest pair the SDK names. The Claude
 * Code workflow (.github/workflows/claude-code.yml) runs it; so can a person:
 *
 *   bun apps/runner/image/bump.ts discover [--pretend <sdk version>]
 *   bun apps/runner/image/bump.ts apply [--dry-run] [--pretend <sdk version>]
 *   bun apps/runner/image/bump.ts body <results dir>      the pull request's body, from the run
 *   bun apps/runner/image/bump.ts scrub                   stdin to stdout without secret values
 *
 * `discover` reads the npm registry (the SDK's `latest` and the Claude Code it names) and
 * Claude Code's own `latest` channel, and says what would change. `apply` verifies the release's
 * manifest.json against Anthropic's release signing key (by fingerprint), downloads the linux-x64
 * binary, checks its SHA-256 and size against the signed manifest, writes pins.json, runs
 * `bun add --exact --ignore-scripts` for the SDK, and checks the SDK's own manifest names the same
 * hash. `--dry-run` does all of that but the two writes. `--pretend` takes the SDK version to
 * act as if pinned (its Claude Code is the one it names), to try the change path when the pins
 * are already current.
 *
 * Why a script of ours and not Renovate or Dependabot: neither computes a download's SHA-256 into
 * a JSON file, checks a GPG signature, or knows the two pins must name the same patch release.
 * Renovate could move both versions with a regex manager, but the hash needs `postUpgradeTasks`,
 * which only a self-hosted Renovate runs, and its pull request would still need this workflow to
 * build the image and run a turn. Opening and updating the pull request is
 * peter-evans/create-pull-request's job, not this script's.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_MODELS } from "../../api/src/claude/models.ts";
import { IMAGE_DIR, type Pins, ROOT, RUNNER } from "./image.ts";
import { redact, secretValues } from "./live.ts";

export const SDK = "@anthropic-ai/claude-agent-sdk";
export const REGISTRY = `https://registry.npmjs.org/${SDK}`;
export const RELEASES = "https://downloads.claude.ai/claude-code-releases";
export const SIGNING_KEY_URL = "https://downloads.claude.ai/keys/claude-code.asc";
/**
 * Anthropic's Claude Code release signing key, as code.claude.com/docs/en/setup publishes it
 * ("Binary integrity and code signing"). The key is fetched; this is what makes it trusted.
 */
export const SIGNING_KEY_FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
export const CHANGELOGS = {
  claude: "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
  sdk: "https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md",
};
export const releaseLink = {
  claude: (v: string) => `https://github.com/anthropics/claude-code/releases/tag/v${v}`,
  sdk: (v: string) =>
    `https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v${v}`,
};
const PLATFORM = "linux-x64";
const PINS = join(IMAGE_DIR, "pins.json");

export const claudeUrl = (version: string) => `${RELEASES}/${version}/${PLATFORM}/claude`;

/* ── versions ── */

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1, 0 or 1, for x.y.z versions; anything else throws rather than guessing an order. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = VERSION.exec(v);
    if (!m) throw new Error(`not an x.y.z version: ${v}`);
    return m.slice(1).map(Number);
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

const patchOf = (v: string) => v.split(".")[2];

/** What the npm registry says of the SDK: its dist-tags and, per version, the Claude Code it names. */
export interface Packument {
  "dist-tags": Record<string, string>;
  versions: Record<string, { version: string; claudeCodeVersion?: string; deprecated?: string }>;
}

export interface Pair {
  sdk: string;
  claude: string;
}

/**
 * The pair an SDK version makes: the Claude Code its package.json names. They are released
 * together with one patch number (0.3.322 with 2.1.322); when that stops being so this throws,
 * saying both, instead of guessing which Claude Code to pin.
 */
export function pairOf(packument: Packument, sdk: string): Pair {
  const claude = packument.versions[sdk]?.claudeCodeVersion;
  if (!claude) throw new Error(`the registry names no claudeCodeVersion for ${SDK}@${sdk}`);
  // Both go on into GITHUB_OUTPUT, a URL and the pull request's title: digits and dots only.
  for (const v of [sdk, claude])
    if (!VERSION.test(v))
      throw new Error(`${SDK}@${sdk} names Claude Code ${JSON.stringify(claude)}: not x.y.z`);
  if (patchOf(claude) !== patchOf(sdk))
    throw new Error(
      `${SDK}@${sdk} names Claude Code ${claude}: their patch numbers no longer match, so ` +
        "the pins are not moved. Read both release notes and set the pair by hand " +
        "(apps/runner/package.json and apps/runner/image/pins.json).",
    );
  return { sdk, claude };
}

export interface Discovery {
  current: Pair;
  latest: Pair;
  /** Claude Code's own `latest` channel, which can be ahead of the newest SDK. */
  claudeChannel: string | null;
  bump: boolean;
  /** Plain sentences for the log and the pull request. */
  notes: string[];
  /** Why nothing moves when a person should hear of it (a run annotation, not a red run). */
  warning?: string;
}

/** What to do, from what is pinned and what the registry and the release channel say. */
export function discover(current: Pair, packument: Packument, claudeChannel: string | null) {
  const tag = packument["dist-tags"].latest;
  if (!tag) throw new Error(`the registry has no latest tag for ${SDK}`);
  const latest = pairOf(packument, tag);
  const notes: string[] = [];
  // A release withdrawn by deprecation, while `latest` still points at it, is not proposed.
  const withdrawn = packument.versions[tag]?.deprecated;
  if (withdrawn) {
    const warning = `The registry's latest Agent SDK ${tag} is deprecated (${JSON.stringify(withdrawn)}); nothing moves.`;
    notes.push(warning);
    return { current, latest, claudeChannel, bump: false, notes, warning } satisfies Discovery;
  }
  const order = compareVersions(latest.sdk, current.sdk);
  if (order === 0)
    notes.push(
      `The pins are current: Agent SDK ${current.sdk} with Claude Code ${current.claude}.`,
    );
  if (order < 0)
    notes.push(
      `The pinned Agent SDK ${current.sdk} is newer than the registry's latest ${latest.sdk}; nothing moves back.`,
    );
  if (order > 0)
    notes.push(
      `Agent SDK ${current.sdk} → ${latest.sdk} and Claude Code ${current.claude} → ${latest.claude}.`,
    );
  if (claudeChannel && compareVersions(claudeChannel, latest.claude) > 0)
    notes.push(
      `Claude Code ${claudeChannel} is out, but no Agent SDK names it yet; ${latest.claude} is the newest pair.`,
    );
  return { current, latest, claudeChannel, bump: order > 0, notes } satisfies Discovery;
}

/* ── the signed manifest ── */

export interface Manifest {
  version: string;
  platforms: Record<string, { checksum: string; size: number }>;
}

/** The manifest's linux-x64 binary, after checking it is the manifest of `version`. */
export function binaryOf(manifest: Manifest, version: string): { sha256: string; size: number } {
  if (manifest.version !== version)
    throw new Error(`the manifest for ${version} says it is ${manifest.version}`);
  const entry = manifest.platforms[PLATFORM];
  if (!entry || !/^[0-9a-f]{64}$/.test(entry.checksum) || !(entry.size > 0))
    throw new Error(`the manifest for ${version} has no ${PLATFORM} checksum and size`);
  return { sha256: entry.checksum, size: entry.size };
}

/**
 * Reads `gpg --status-fd` output: a good signature, made by the key with `fingerprint` as its
 * primary key, and nothing bad. Answers why not, or null when it holds.
 */
export function signatureProblem(status: string, fingerprint = SIGNING_KEY_FINGERPRINT) {
  const lines = status.split("\n").filter((l) => l.startsWith("[GNUPG:] "));
  const has = (word: string) => lines.some((l) => l.split(" ")[1] === word);
  for (const bad of ["BADSIG", "ERRSIG", "EXPSIG", "EXPKEYSIG", "REVKEYSIG", "NO_PUBKEY"])
    if (has(bad)) return `gpg said ${bad}`;
  if (!has("GOODSIG")) return "gpg found no good signature";
  const valid = lines.find((l) => l.split(" ")[1] === "VALIDSIG")?.split(" ");
  if (!valid) return "gpg found no valid signature";
  // VALIDSIG <key fpr> <date> <time> <expires> <version> <reserved> <algo> <hash> <class> <primary fpr>
  const primary = valid[11] ?? valid[2];
  if (primary !== fingerprint) return `signed by ${primary}, not ${fingerprint}`;
  return null;
}

/** Verifies `sig` over `data` with the key at `keyFile`, in a keyring of its own. */
export function verifySignature(keyFile: string, data: string, sig: string): string | null {
  const home = mkdtempSync(join(tmpdir(), "ponzu-gpg-"));
  try {
    const gpg = (args: string[]) =>
      spawnSync("gpg", ["--homedir", home, "--batch", "--no-tty", ...args], { encoding: "utf8" });
    const imported = gpg(["--import", keyFile]);
    if (imported.error) return `gpg did not run: ${imported.error.message}`;
    return signatureProblem(gpg(["--status-fd", "1", "--verify", sig, data]).stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/* ── release notes ── */

/** The `## <version>` sections of a changelog after `from`, up to and including `to`. */
export function changelogBetween(markdown: string, from: string, to: string) {
  const sections: { version: string; body: string }[] = [];
  for (const part of markdown.split(/^## /m).slice(1)) {
    const [heading = "", ...rest] = part.split("\n");
    const version = heading.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (compareVersions(version, from) > 0 && compareVersions(version, to) <= 0)
      sections.push({ version, body: rest.join("\n").trim() });
  }
  return sections;
}

/** Model ids the notes name that Ponzu does not offer (apps/api/src/claude/models.ts). */
export function modelsNotOffered(text: string, offered = CLAUDE_MODELS.map((m) => m.id)) {
  const named = new Set(text.match(/\bclaude-(?!code\b)[a-z]+-\d+(?:-\d+)?\b/g) ?? []);
  return [...named].filter((id) => !offered.includes(id)).sort();
}

/* ── the pull request ── */

/** A step's outcome, as GitHub Actions reports it (empty when the step never ran). */
export type Outcome = "success" | "failure" | "cancelled" | "skipped" | "";

/** What `apply` wrote for the rest of the run, beside pins.json. */
export interface Applied {
  discovery: Discovery;
  pins: Pick<Pins, "claudeVersion" | "claudeUrl" | "claudeSha256">;
  size: number;
  changelog: {
    claude: { version: string; body: string }[];
    sdk: { version: string; body: string }[];
  };
  modelsNotOffered: string[];
}

export interface RunResults {
  applied: Applied;
  typecheck: { outcome: Outcome; log: string };
  tests: { outcome: Outcome; log: string };
  /** image.yml's answer: built, failed, or skipped with why. */
  image: {
    result: "built" | "failed" | "skipped" | "";
    reason: string;
    log: string;
    image: string;
  };
  turn: { outcome: Outcome; reason: string; log: string };
  /** The run, for links. */
  runUrl: string;
}

const tail = (log: string, n = 3500) => (log.length > n ? `…\n${log.slice(-n)}` : log).trim();
const block = (log: string) => `\n\n\`\`\`\n${tail(log).replaceAll("```", "'''")}\n\`\`\`\n`;
/** The check checks.ts names when one fails (runChecks). */
const failedCheck = (log: string) => /check failed: (.+)/.exec(log)?.[1]?.trim() ?? null;

/** Every row's verdict, the draft decision, and the body. */
export function pullRequest(r: RunResults) {
  const { discovery: d, pins } = r.applied;
  const rows: { what: string; short: string; ok: boolean; skipped: boolean; says: string }[] = [];
  const row = (
    [what, short]: [string, string],
    outcome: Outcome,
    ok: string,
    bad: string,
    skipped: string,
  ) =>
    rows.push({
      what,
      short,
      ok: outcome === "success",
      skipped: outcome === "skipped" || outcome === "",
      says:
        outcome === "success"
          ? ok
          : outcome === "failure" || outcome === "cancelled"
            ? bad
            : skipped,
    });
  row(
    ["Typecheck", "the typecheck"],
    r.typecheck.outcome,
    "passes with the new SDK's types",
    "**fails**: the new SDK's types no longer fit how the runner calls it (log below)",
    "did not run",
  );
  row(
    ["Runner and image tests", "the tests"],
    r.tests.outcome,
    "pass",
    "**fail** (log below)",
    "did not run",
  );
  const check = failedCheck(r.image.log);
  const imageOutcome: Outcome =
    r.image.result === "built" ? "success" : r.image.result === "failed" ? "failure" : "skipped";
  row(
    ["Image, its checks and their Haiku turn (build.ts, checks.ts)", "the image or its checks"],
    imageOutcome,
    `built, Ready in the registry and checked in a sandbox: \`${r.image.image}\`, recorded in current.json`,
    check
      ? `**fails** at the check "${check}" (log below)`
      : r.image.reason
        ? `**fails**: ${r.image.reason}`
        : "**fails** to build or push (log below)",
    `not built: ${r.image.reason || "the image job did not run"}`,
  );
  row(
    [
      "A real turn (e2e.ts scratch: Haiku at low effort, a create, two sleeps and wakes)",
      "the real turn",
    ],
    r.turn.outcome,
    "passes",
    "**fails** (log below)",
    `not run: ${r.turn.reason || "there was no image to run it on"}`,
  );
  const failed = rows.some((x) => !x.ok && !x.skipped);
  const draft = rows.some((x) => !x.ok);
  const failing = rows.filter((x) => !x.ok && !x.skipped).map((x) => x.short);
  const lead = failed
    ? `**This is a draft because ${failing.join(" and ")} failed.** Do not merge it until a run passes.`
    : draft
      ? "**This is a draft because some checks could not run** (the table says which and why). Do not merge it until they have."
      : "Everything below passed. Review the release notes, then merge.";

  const lines = [
    lead,
    "",
    `Moves the Agent SDK from ${d.current.sdk} to **${d.latest.sdk}** and Claude Code from ${d.current.claude} to **${d.latest.claude}**, together: the SDK's package names exactly that Claude Code, and the runner refuses an image whose Claude Code is not the one its SDK names.`,
    ...d.notes.slice(1).map((n) => `\n${n}`),
    "",
    "| | |",
    "|---|---|",
    `| pins.json | \`${pins.claudeUrl}\`, sha256 \`${pins.claudeSha256}\` (${r.applied.size} bytes), computed from the download; it matches the release's manifest.json, whose signature is by Anthropic's release key \`${SIGNING_KEY_FINGERPRINT}\`, and the SDK package's own manifest |`,
    ...rows.map((x) => `| ${x.what} | ${x.says} |`),
    `| CI | dispatched on this pull request's head after it was opened (the run shows in its checks) |`,
    "",
    "## What changed upstream",
    "",
    ...notesSection("Claude Code", r.applied.changelog.claude, releaseLink.claude(d.latest.claude)),
    ...notesSection("Agent SDK", r.applied.changelog.sdk, releaseLink.sdk(d.latest.sdk)),
  ];
  if (r.applied.modelsNotOffered.length)
    lines.push(
      `These notes name models Ponzu's hand-kept list does not have: ${r.applied.modelsNotOffered.map((m) => `\`${m}\``).join(", ")}. An account is offered one once a runner on this image reports it. To give one a name and a place in the picker, and to offer it before a report, add it to \`CLAUDE_MODELS\` in apps/api/src/claude/models.ts, in this pull request or after it.`,
      "",
    );
  lines.push(
    "## How to review",
    "",
    "1. Read the release notes above for anything that changes how the runner drives Claude Code: permissions, hooks, sessions, the SDK's options and messages (apps/runner/src/agent/sdk.ts).",
    "2. The table must be all passes. A typecheck failure means the SDK's API changed: fix the runner in this branch. A failing check or turn with a passing typecheck means Claude Code behaves differently: read the log.",
    '3. Merging ships the image with the next API deploy; each design moves to it at its next wake (docs/cloud.md, "How images roll out").',
    "",
    `Made by [this run](${r.runUrl}) of the Claude Code workflow (apps/runner/image/bump.ts). Nothing merges it but a person.`,
  );
  for (const [name, log, show] of [
    ["Typecheck", r.typecheck.log, r.typecheck.outcome === "failure"],
    ["Tests", r.tests.log, r.tests.outcome === "failure"],
    ["Image", r.image.log, r.image.result === "failed"],
    ["Turn", r.turn.log, r.turn.outcome === "failure"],
  ] as const)
    if (show && log.trim())
      lines.push("", `<details><summary>${name} log (the end)</summary>${block(log)}</details>`);
  // GitHub refuses a body over 65536 characters.
  return { draft, failed, body: `${lines.join("\n")}\n`.slice(0, 60_000) };
}

function notesSection(name: string, sections: { version: string; body: string }[], link: string) {
  if (!sections.length) return [`**${name}**: no changelog sections were found; see ${link}.`, ""];
  return (
    sections
      // The start of each section: the additions come first.
      .flatMap((s) => [
        `**${name} ${s.version}**`,
        "",
        s.body.length > 6000 ? `${s.body.slice(0, s.body.lastIndexOf("\n", 6000))}\n- …` : s.body,
        "",
      ])
      .concat([`Release: ${link}`, ""])
  );
}

/* ── what the commands do ── */

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

function pinned(pretend: string | null, packument: Packument): Pair {
  if (pretend) return pairOf(packument, pretend);
  const pkg = JSON.parse(readFileSync(join(RUNNER, "package.json"), "utf8"));
  const pins = JSON.parse(readFileSync(PINS, "utf8")) as Pins;
  return { sdk: pkg.dependencies[SDK], claude: pins.claudeVersion };
}

async function runDiscover(pretend: string | null): Promise<Discovery> {
  const packument = (await (await fetchOk(REGISTRY)).json()) as Packument;
  const channel = await fetch(`${RELEASES}/latest`)
    .then(async (r) => (r.ok ? (await r.text()).trim() : null))
    .catch(() => null);
  return discover(pinned(pretend, packument), packument, channel);
}

/** A stream's chunks, as they come. */
async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/** Streams the binary through SHA-256, so its 340 MB never sit on the disk or in memory. */
async function hashDownload(url: string): Promise<{ sha256: string; size: number }> {
  const r = await fetchOk(url);
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of chunks(r.body!)) {
    hasher.update(chunk);
    size += chunk.byteLength;
  }
  return { sha256: hasher.digest("hex"), size };
}

async function runApply(d: Discovery, dryRun: boolean): Promise<Applied> {
  const { claude, sdk } = d.latest;
  const dir = mkdtempSync(join(tmpdir(), "ponzu-bump-"));
  try {
    const file = (name: string, bytes: ArrayBuffer) => {
      writeFileSync(join(dir, name), new Uint8Array(bytes));
      return join(dir, name);
    };
    const manifestBytes = await (
      await fetchOk(`${RELEASES}/${claude}/manifest.json`)
    ).arrayBuffer();
    const problem = verifySignature(
      file("key.asc", await (await fetchOk(SIGNING_KEY_URL)).arrayBuffer()),
      file("manifest.json", manifestBytes),
      file(
        "manifest.json.sig",
        await (await fetchOk(`${RELEASES}/${claude}/manifest.json.sig`)).arrayBuffer(),
      ),
    );
    if (problem) throw new Error(`Claude Code ${claude}'s manifest.json signature: ${problem}`);
    console.log(`manifest.json for ${claude}: good signature by ${SIGNING_KEY_FINGERPRINT}`);
    const want = binaryOf(JSON.parse(new TextDecoder().decode(manifestBytes)), claude);
    const url = claudeUrl(claude);
    const got = await hashDownload(url);
    if (got.sha256 !== want.sha256 || got.size !== want.size)
      throw new Error(
        `${url} is ${got.size} bytes with sha256 ${got.sha256}; the signed manifest says ${want.size} bytes, ${want.sha256}`,
      );
    console.log(`${url}: ${got.size} bytes, sha256 ${got.sha256}, as the signed manifest says`);

    const pins = { claudeVersion: claude, claudeUrl: url, claudeSha256: got.sha256 };
    const before = JSON.parse(readFileSync(PINS, "utf8")) as Pins;
    console.log(`pins.json claudeVersion: ${d.current.claude} → ${claude}`);
    console.log(`pins.json claudeUrl: ${claudeUrl(d.current.claude)} → ${url}`);
    console.log(`pins.json claudeSha256: → ${got.sha256}`);
    console.log(`apps/runner/package.json ${SDK}: ${d.current.sdk} → ${sdk} (and bun.lock)`);
    if (!dryRun) {
      writeFileSync(PINS, `${JSON.stringify({ ...before, ...pins }, null, 2)}\n`);
      const added = spawnSync("bun", ["add", "--exact", "--ignore-scripts", `${SDK}@${sdk}`], {
        cwd: RUNNER,
        stdio: "inherit",
      });
      if (added.status !== 0) throw new Error(`bun add ${SDK}@${sdk} exited ${added.status}`);
      // The SDK ships the same manifest; image.test.ts holds pins.json to it too.
      const installed = dirname(Bun.resolveSync(`${SDK}/package.json`, RUNNER));
      const theirs = binaryOf(
        JSON.parse(readFileSync(join(installed, "manifest.json"), "utf8")),
        claude,
      );
      if (theirs.sha256 !== got.sha256)
        throw new Error(`the installed SDK's manifest names ${theirs.sha256}, not ${got.sha256}`);
    }

    const notes = async (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
    const changelog = {
      claude: changelogBetween(await notes(CHANGELOGS.claude), d.current.claude, claude),
      sdk: changelogBetween(await notes(CHANGELOGS.sdk), d.current.sdk, sdk),
    };
    const text = [...changelog.claude, ...changelog.sdk].map((s) => s.body).join("\n");
    return {
      discovery: d,
      pins,
      size: got.size,
      changelog,
      modelsNotOffered: modelsNotOffered(text),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readOr(path: string, otherwise = ""): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return otherwise;
  }
}

/** The run's results, from the files and outcomes the workflow gathered in `dir`. */
function gather(dir: string): RunResults {
  const env = process.env;
  const current = readOr(join(dir, "current.json"));
  return {
    applied: JSON.parse(readFileSync(join(dir, "applied.json"), "utf8")),
    typecheck: {
      outcome: (env.TYPECHECK ?? "") as Outcome,
      log: readOr(join(dir, "typecheck.log")),
    },
    tests: { outcome: (env.TESTS ?? "") as Outcome, log: readOr(join(dir, "tests.log")) },
    image: {
      result: (env.IMAGE_RESULT ?? "") as RunResults["image"]["result"],
      reason: env.IMAGE_REASON ?? "",
      log: readOr(join(dir, "image.log")),
      image: current ? (JSON.parse(current) as { image: string }).image : "",
    },
    turn: {
      outcome: (env.TURN ?? "") as Outcome,
      reason: env.TURN_REASON ?? "",
      log: readOr(join(dir, "turn.log")),
    },
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  };
}

/** Appends `name=value` lines for the next steps (GITHUB_OUTPUT), when there is one. */
function output(values: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  const text = Object.entries(values)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  if (file) writeFileSync(file, text, { flag: "a" });
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => rest.includes(name);
  const value = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? (rest[i + 1] ?? null) : null;
  };
  const pretend = value("--pretend");
  const results = join(ROOT, ".context", "bump");

  if (command === "discover" || command === "apply") {
    const d = await runDiscover(pretend);
    for (const note of d.notes) console.log(note);
    // A deprecated latest is no reason to turn every push to cloud red, but it is shown.
    if (d.warning && process.env.GITHUB_ACTIONS)
      console.log(`::warning title=Nothing moves::${d.warning}`);
    output({
      bump: String(d.bump),
      sdk: d.latest.sdk,
      claude: d.latest.claude,
      from: d.current.claude,
    });
    if (command === "apply" && d.bump) {
      const applied = await runApply(d, flag("--dry-run"));
      mkdirSync(results, { recursive: true });
      writeFileSync(join(results, "applied.json"), `${JSON.stringify(applied, null, 2)}\n`);
      console.log(
        `release notes: ${applied.changelog.claude.map((s) => s.version).join(", ") || "none"} (Claude Code), ${applied.changelog.sdk.map((s) => s.version).join(", ") || "none"} (SDK)`,
      );
      if (applied.modelsNotOffered.length)
        console.log(
          `models named that Ponzu does not offer: ${applied.modelsNotOffered.join(", ")}`,
        );
      console.log(flag("--dry-run") ? "dry run: nothing written" : "written");
    }
  } else if (command === "body") {
    const dir = rest[0] ?? results;
    const pr = pullRequest(gather(dir));
    writeFileSync(join(dir, "body.md"), pr.body);
    output({ draft: String(pr.draft), failed: String(pr.failed) });
    console.log(pr.body);
  } else if (command === "scrub") {
    // Line by line, so a long build still shows as it goes. A secret never spans lines.
    const secrets = [...secretValues(process.env).values()].filter((v) => v.length >= 12);
    const clean = (line: string) => redact(secrets.reduce((t, s) => t.replaceAll(s, "***"), line));
    const decoder = new TextDecoder();
    let held = "";
    for await (const chunk of chunks(Bun.stdin.stream())) {
      const lines = (held + decoder.decode(chunk, { stream: true })).split("\n");
      held = lines.pop() ?? "";
      if (lines.length) process.stdout.write(`${lines.map(clean).join("\n")}\n`);
    }
    process.stdout.write(clean(held + decoder.decode()));
  } else {
    console.error("say discover, apply, body or scrub (see the comment at the top)");
    process.exit(2);
  }
}
