/*
 * The runner's entry: `bun runner.js` in a design's sandbox, as the ponzu-runner systemd
 * service. README.md has its environment and how to run it elsewhere.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumRenderer } from "@ponzu/render/chromium";
import { ClaudeAgent } from "./agent/sdk.ts";
import { fatal } from "./api/api.ts";
import { HttpRunnerApi } from "./api/http.ts";
import { decodeRepoSecrets, REPO_SECRETS_VARIABLE } from "./api/protocol.ts";
import { agentEnv, EnvError, readEnv } from "./env.ts";
import { agentFiles } from "./files.ts";
import { receivePackProbe } from "./git-token.ts";
import { checkout } from "./repo.ts";
import { Runner } from "./run.ts";
import { agentShell } from "./save/shell.ts";
import { Transcripts } from "./save/transcripts.ts";
import { GitWork, gitIn, ScratchWork } from "./save/work.ts";
import { serve, serveCredentials } from "./server.ts";
import { VERSION } from "./version.ts";

/**
 * What a restart will not mend (configuration, a revoked token, a newer runner holding the
 * lease): systemd is told not to try (RestartPreventExitStatus).
 */
const EXIT_CONFIG = 78;
/** Where the environment carries the owner's Claude credential. */
const CLAUDE_CREDENTIALS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
/** The Claude Code the sandbox image installs. */
const IMAGE_CLAUDE = "/usr/local/bin/claude";

const log = (message: string) => console.error(`[runner] ${message}`);

/** Claude Code's config folder, where its transcripts are: the image sets it for both users. */
function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
}

/** This boot of the machine, and when it began: what tells boat which boot's writes came back. */
function boot(): { id: string | null; at: string | null } {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    return { id, at: btime ? new Date(Number(btime) * 1000).toISOString() : null };
  } catch {
    return { id: null, at: null };
  }
}

let env: ReturnType<typeof readEnv>;
try {
  env = readEnv(process.env);
} catch (err) {
  if (!(err instanceof EnvError)) throw err;
  log(err.message);
  process.exit(EXIT_CONFIG);
}

const client = `runner/${VERSION}`;
const here = dirname(fileURLToPath(import.meta.url));
// Beside this file: the source in a checkout, the bundle in the image.
const helperFile = join(
  here,
  import.meta.url.endsWith(".ts") ? "credential.ts" : "git-credential.js",
);

const runner = new Runner({
  api: new HttpRunnerApi({
    baseUrl: env.apiUrl,
    designId: env.designId,
    token: env.token,
    client,
  }),
  agent: new ClaudeAgent({
    executable: env.claude ?? (existsSync(IMAGE_CLAUDE) ? IMAGE_CLAUDE : undefined),
    client: `ponzu-${client}`,
    log: (line) => log(`claude: ${line}`),
    env: agentEnv(process.env),
  }),
  ...(env.asAgent ? { files: agentFiles(env.asAgent, agentEnv(process.env)) } : {}),
  // The repo's dev server is on this machine, so a design may load from it.
  renderer: new ChromiumRenderer({
    loopback: true,
    ...(env.chromium ? { executablePath: env.chromium } : {}),
  }),
  // The helper asks this process, which asks through its lease: the git of a runner that was
  // superseded gets nothing, and the agent's git holds no runner token.
  prepare: (session) =>
    checkout(session, {
      root: env.workRoot,
      helper: `!'${process.execPath}' '${helperFile}' '${env.gitSocket}'`,
      env: agentEnv(process.env),
      ...(env.git ? { git: env.git } : {}),
    }),
  stateDir: env.stateDir,
  // Every filesystem, so the agent's files are flushed with the runner's own.
  flush: () =>
    new Promise<void>((resolve) => {
      spawn("sync", { stdio: "ignore" })
        .on("error", (err) => {
          log(`sync: ${err}`);
          resolve();
        })
        .on("close", () => resolve());
    }),
  // What a checkpoint keeps: Claude Code's transcripts, read and written back as the agent, and
  // the work in progress (a repo's on its hidden ref, Scratch's as an archive).
  saving: (session, cwd, checkedOut) => {
    const asAgent = agentShell(env.asAgent, agentEnv(process.env));
    const transcripts = new Transcripts({
      configDir: claudeConfigDir(process.env),
      shell: asAgent,
    });
    if (session.repo && !checkedOut) return { transcripts, work: null };
    // What a checkpoint never carries: the repo's secrets and the Claude credential, which the
    // next sandbox's environment brings back.
    const secrets = [
      ...Object.values(decodeRepoSecrets(process.env[REPO_SECRETS_VARIABLE])),
      ...CLAUDE_CREDENTIALS.flatMap((name) => process.env[name] ?? []),
    ];
    const work =
      session.repo && session.branch
        ? new GitWork({
            cwd,
            designId: session.design.id,
            branch: session.branch,
            defaultBranch: session.repo.defaultBranch,
            // The image's git already runs as the agent; elsewhere the agent is this user.
            git: gitIn(agentShell(undefined, agentEnv(process.env)), env.git ?? "git", cwd),
            secrets,
            log,
          })
        : new ScratchWork({ cwd, shell: asAgent, secrets });
    return { transcripts, work };
  },
  boot,
  // The runner pushes the design's branch with the agent's git, so the checkout stays theirs.
  checkoutGit: (cwd) => gitIn(agentShell(undefined, agentEnv(process.env)), env.git ?? "git", cwd),
  // A token goes to git once GitHub's git endpoint honours it for a push (git-token.ts).
  gitProbe: receivePackProbe(),
  log,
  event: (name, fields) => log(JSON.stringify({ event: name, designId: env.designId, ...fields })),
  onFatal: () => {
    server.stop();
    process.exit(EXIT_CONFIG);
  },
});

const server = serve({
  port: env.port,
  poke: () => runner.poke(),
  report: () => runner.report(),
  health: () => runner.health(),
});
log(`listening on ${server.port}`);
mkdirSync(dirname(env.gitSocket), { recursive: true });
const credentials = serveCredentials({
  path: env.gitSocket,
  get: (ask) => runner.gitCredential(ask),
  erase: (ask) => runner.eraseGitCredential(ask),
});

const shutdown = async (signal: string) => {
  log(`${signal}: stopping`);
  await runner.stop();
  server.stop();
  credentials.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await runner.start();
  log("started");
} catch (err) {
  log(`could not start: ${err instanceof Error ? err.message : err}`);
  // A token the API refuses stays refused: only a new start of the sandbox brings a new one.
  process.exit(fatal(err) ? EXIT_CONFIG : 1);
}
