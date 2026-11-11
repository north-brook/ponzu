import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Doc } from "@ponzu/core";
import { ChromiumRenderer } from "@ponzu/render/chromium";
import { ClaudeAgent } from "../../src/agent/sdk.ts";
import { FakeRunnerApi } from "../../src/api/fake.ts";
import type { EventBody, GitReport, ThreadItem, TurnUsage } from "../../src/api/protocol.ts";
import { checkout } from "../../src/repo.ts";
import { Runner } from "../../src/run.ts";
import { agentShell } from "../../src/save/shell.ts";
import { gitIn } from "../../src/save/work.ts";
import { FITNESS_REPO } from "./seeds.ts";

/*
 * One real turn of the design agent, the way a sandbox runs it, on this machine: the runner
 * (`Runner`) in process against the API in memory (`FakeRunnerApi`), real Claude Code through the
 * Agent SDK on a Claude sign-in, real screenshots from a headless Chromium, and a real git
 * repository standing in for GitHub. Each turn gets its own folders, Claude config and home, so
 * nothing from this machine's own Claude or git reaches it, and nothing of one case another.
 *
 * The repository is a bare one on disk; the checkout's git reads it as
 * `https://github.com/ada/fitness-app.git` (`url.insteadOf`), so commits and pushes are real and
 * the agent sees GitHub's address. A case that refuses pushes gets a pre-receive hook that
 * answers as GitHub did in the founder's session: "Repository not found".
 */

export const REPO_URL = "https://github.com/ada/fitness-app.git";
/**
 * What git says when the stand-in refuses a push: the hook's line, and git's own about the hook.
 * GitHub's real refusal has the first and not the second.
 */
export const REFUSAL =
  '"remote: Repository not found." and "! [remote rejected] pz/onboarding -> pz/onboarding (pre-receive hook declined)"';
const BRANCH = "pz/onboarding";

export interface TurnSetup {
  /** The design's id: its links are `https://ponzu.design/designs/<id>…`. */
  designId: string;
  doc: Doc;
  /** A design on the fitness app's repository, or Scratch. */
  repo: boolean;
  /** Every push is refused, as GitHub refused a token it had just minted. */
  refusePush?: boolean;
  /** What begins the turn: a message, or a comment on the canvas. */
  event: EventBody;
}

export interface TurnOutcome {
  /** The thread items the turn wrote, in order. */
  items: ThreadItem[];
  /** What the agent wrote while it worked, and its answer. */
  midTurn: string[];
  closing: string | null;
  docBefore: Doc;
  docAfter: Doc;
  /** Commits on the design's branch, as unix seconds and subject, oldest first. */
  commits: { at: number; subject: string }[];
  /** Commits the remote holds of the branch. */
  pushed: number;
  /** What the runner reported of its pushes. */
  gitReports: GitReport[];
  /** The branch as the runner last reported it: commits GitHub lacks, and why. */
  branch: { unpushed: number; error: string | null } | null;
  /** Error notices the runner wrote in the thread during the turn. */
  errors: string[];
  /** Every `describe_pull_request`, when it came, as unix milliseconds. */
  summaries: { at: number; text: string }[];
  usage: TurnUsage[];
  /** Questions the agent raised, answered "Your call". */
  questions: number;
  durationMs: number;
  /** The turn's step log as the thread folds it. */
  steps: string[];
  ended: string | null;
}

export interface HarnessOptions {
  /** The Claude sign-in's token (`CLAUDE_CODE_OAUTH_TOKEN`). Never logged. */
  token: string;
  /** Claude Code. */
  claude: string;
  /** A Chromium for screenshots. */
  chromium?: string;
  log(line: string): void;
  /** The longest a turn may run. */
  timeoutMs?: number;
}

/** The newest Chromium Headless Shell Playwright installed, if any. */
export function findHeadlessShell(): string | undefined {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const dir of dirs) {
    for (const arch of [
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell-mac-x64",
      "chrome-headless-shell-linux64",
    ]) {
      const bin = join(cache, dir, arch, "chrome-headless-shell");
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export async function runTurn(setup: TurnSetup, opts: HarnessOptions): Promise<TurnOutcome> {
  const root = mkdtempSync(join(tmpdir(), "ponzu-eval-"));
  const home = join(root, "home");
  const configDir = join(root, "claude");
  for (const dir of [home, configDir]) mkdirSync(dir, { recursive: true });
  // Only what Claude Code and git need: never this process's keys.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER,
    LANG: "en_US.UTF-8",
    TMPDIR: join(root, "tmp"),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: opts.token,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  mkdirSync(env.TMPDIR!, { recursive: true });

  const bare = join(root, "remote", "fitness-app.git");
  if (setup.repo) seedRepository(bare, root, env, Boolean(setup.refusePush));

  const api = new FakeRunnerApi({
    doc: structuredClone(setup.doc),
    session: {
      design: { id: setup.designId, name: setup.doc.name },
      repo: setup.repo ? { owner: "ada", name: "fitness-app", defaultBranch: "main" } : null,
      branch: setup.repo ? BRANCH : null,
      model: "claude-opus-5-5",
      effort: "high",
      link: `https://ponzu.design/designs/${setup.designId}`,
    },
  });
  const summaries: { at: number; text: string }[] = [];
  const summarize = api.pullRequestSummary.bind(api);
  api.pullRequestSummary = async (runner, text) => {
    summaries.push({ at: Date.now(), text });
    return summarize(runner, text);
  };

  const shell = agentShell(undefined, env);
  const runner = new Runner({
    api: api.client(),
    agent: new ClaudeAgent({
      executable: opts.claude,
      client: "ponzu-evals",
      log: () => {},
      env,
    }),
    renderer: new ChromiumRenderer({
      loopback: true,
      ...(opts.chromium ? { executablePath: opts.chromium } : {}),
    }),
    prepare: (session) => checkout(session, { root: join(root, "work"), helper: "!true", env }),
    stateDir: join(root, "state"),
    checkoutGit: (cwd) => gitIn(shell, "git", cwd),
    secrets: [opts.token],
    log: () => {},
  });

  const started = Date.now();
  const docBefore = structuredClone(api.doc.doc);
  let questions = 0;
  try {
    await runner.start();
    const event = api.push(setup.event);
    runner.poke();
    const deadline = started + (opts.timeoutMs ?? 40 * 60_000);
    let ended: ThreadItem | undefined;
    let lastNote = 0;
    while (!ended) {
      if (Date.now() > deadline) throw new Error("the turn ran past its time");
      await Bun.sleep(1_000);
      // Any question gets "Your call", as a person who left it to the agent would answer.
      for (const q of api.questions.values()) {
        if (q.status !== "open") continue;
        questions++;
        api.answer(
          q.kind === "question"
            ? {
                questionId: q.id,
                answers: Object.fromEntries(
                  q.payload.questions.map((x) => [x.question, "Your call."]),
                ),
              }
            : { questionId: q.id, approved: true, note: "Your call." },
        );
        runner.poke();
      }
      ended = api
        .items()
        .find(
          (item) =>
            item.seq > event.seq &&
            item.kind === "tool" &&
            item.payload.turn?.ended != null &&
            !item.streaming,
        );
      if (Date.now() - lastNote > 60_000) {
        lastNote = Date.now();
        opts.log(
          `  … ${Math.round((Date.now() - started) / 1000)} s, ${api.items().filter((i) => i.kind === "assistant").length} message(s)`,
        );
      }
    }
    // The runner pushes the branch once the turn ends (with retries on a refusal): wait for it.
    const settle = Date.now() + 90_000;
    while (Date.now() < settle) {
      if (api.usage.size > 0 && api.lastState?.state === "idle") break;
      await Bun.sleep(1_000);
    }
    const items = api.items();
    const turnItem = ended.kind === "tool" ? ended.payload.turn : undefined;
    const said = items.filter((item) => item.kind === "assistant" && item.seq > event.seq);
    const finalId = turnItem?.final ?? null;
    const text = (item: ThreadItem) => (item.kind === "assistant" ? item.payload.text : "");
    const closing = finalId ? said.find((item) => item.id === finalId) : undefined;
    const outcome: TurnOutcome = {
      items,
      midTurn: said.filter((item) => item.id !== finalId).map(text),
      closing: closing ? text(closing) : null,
      docBefore,
      docAfter: structuredClone(api.doc.doc),
      commits: [],
      pushed: 0,
      gitReports: [...api.gitReports],
      branch: api.branch ?? null,
      errors: items.flatMap((item) =>
        item.seq > event.seq && item.kind === "notice" && item.payload.type === "error"
          ? [`${item.payload.code}: ${item.payload.message}`]
          : [],
      ),
      summaries,
      usage: [...api.usage.values()],
      questions,
      durationMs: Date.now() - started,
      steps: (turnItem?.log ?? []).flatMap((group) =>
        group.text ? [`${group.text}${group.count > 1 ? ` ×${group.count}` : ""}`] : [],
      ),
      ended: turnItem?.ended ?? null,
    };
    if (setup.repo) {
      const cwd = join(root, "work", "fitness-app");
      const log = run(
        "git",
        ["log", "--format=%ct%x09%s", `origin/main..${BRANCH}`],
        cwd,
        env,
      ).trim();
      outcome.commits = log
        ? log
            .split("\n")
            .map((line) => {
              const [at, ...subject] = line.split("\t");
              return { at: Number(at), subject: subject.join("\t") };
            })
            .reverse()
        : [];
      try {
        outcome.pushed = Number(
          run(
            "git",
            ["--git-dir", bare, "rev-list", "--count", `main..${BRANCH}`],
            root,
            env,
          ).trim(),
        );
      } catch {
        outcome.pushed = 0;
      }
    }
    return outcome;
  } finally {
    await runner.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/** The fitness app's repository on main, as a bare repo; with `refuse`, one that takes no push. */
function seedRepository(bare: string, root: string, env: NodeJS.ProcessEnv, refuse: boolean) {
  const gitEnv = {
    ...env,
    GIT_AUTHOR_NAME: "Ada",
    GIT_AUTHOR_EMAIL: "1+ada@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Ada",
    GIT_COMMITTER_EMAIL: "1+ada@users.noreply.github.com",
  };
  mkdirSync(bare, { recursive: true });
  run("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare], root, gitEnv);
  const src = join(root, "seed");
  mkdirSync(src, { recursive: true });
  run("git", ["init", "--quiet", "--initial-branch=main"], src, gitEnv);
  for (const [path, text] of Object.entries(FITNESS_REPO)) {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  run("git", ["add", "-A"], src, gitEnv);
  run("git", ["commit", "--quiet", "-m", "Product notes and the onboarding spec"], src, gitEnv);
  run("git", ["push", "--quiet", bare, "main"], src, gitEnv);
  rmSync(src, { recursive: true, force: true });
  if (refuse) {
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, '#!/bin/sh\necho "remote: Repository not found." >&2\nexit 1\n');
    chmodSync(hook, 0o755);
  }
  // The checkout reads the bare repo as GitHub's address.
  writeFileSync(
    join(env.HOME!, ".gitconfig"),
    `[url "file://${bare}"]\n\tinsteadOf = ${REPO_URL}\n[init]\n\tdefaultBranch = main\n`,
  );
}
