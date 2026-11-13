/*
 * The runner's entry: `bun runner.js` in a canvas's sandbox, started and restarted by the
 * supervisor (supervise.ts), which the API starts with a detached command at every start of the
 * sandbox. README.md has its environment and how to run it elsewhere.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knownSecrets, redactText } from "@ponzu/core/redact";
import { ChromiumRenderer } from "@ponzu/render/chromium";
import { ClaudeAgent } from "./agent/sdk.ts";
import { fatal } from "./api/api.ts";
import { HttpRunnerApi } from "./api/http.ts";
import { SECRETS_FOLDER } from "./api/protocol.ts";
import { agentEnv, EnvError, readEnv, secretValues } from "./env.ts";
import { agentFiles } from "./files.ts";
import { receivePackProbe } from "./git-token.ts";
import { checkout } from "./repo.ts";
import { Runner } from "./run.ts";
import { agentShell } from "./save/shell.ts";
import { Transcripts } from "./save/transcripts.ts";
import { GitWork, gitIn, ScratchWork } from "./save/work.ts";
import { agentSecretWriter, localSecretWriter } from "./secret-tool.ts";
import { serve, serveCredentials } from "./server.ts";
import { posthogTelemetry } from "./telemetry.ts";
import { ToolsRunner } from "./tools-mode.ts";
import { runnerClient } from "./version.ts";

/**
 * What a restart will not mend (configuration, a revoked token, a newer runner holding the
 * lease): the supervisor does not try again (supervise.ts).
 */
const EXIT_CONFIG = 78;

/**
 * Every line the runner writes (Claude Code's stderr among them) goes to its log file on the
 * persistent disk, so into every snapshot: the known secret values are taken out first.
 */
const startSecrets = (() => {
  try {
    return secretValues(process.env);
  } catch {
    return [];
  }
})();
/**
 * The repo's secrets and the Claude credential, and every secret a person gives mid-turn as it
 * is given (`keepSecret`): one list, read where it is used, by the log, checkpoints and traces.
 */
const scrubbed: string[] = [...startSecrets];
let logSecrets = knownSecrets(scrubbed);
const log = (message: string) => console.error(`[runner] ${redactText(message, logSecrets)}`);

/** Claude Code's config folder, where its transcripts are: the image sets it for both users. */
function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
}

/** This boot of the machine, and when it began: what tells which boot's writes came back. */
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

const client = runnerClient();

/*
 * Tools mode (docs/cloud.md, "Driving a canvas"): a person's own agent drives the canvas, so no
 * Claude Code, no checkout and no agent's side; only the canvas, its renderer and its tools for
 * the agent's calls, which the API relays to `POST /tool`.
 */
if (env.mode === "tools") {
  const tools = new ToolsRunner({
    api: new HttpRunnerApi({
      baseUrl: env.apiUrl,
      canvasId: env.canvasId,
      token: env.token,
      client,
    }),
    renderer: new ChromiumRenderer({
      loopback: true,
      ...(env.chromium ? { executablePath: env.chromium } : {}),
    }),
    log,
    onFatal: () => {
      toolServer.stop();
      process.exit(EXIT_CONFIG);
    },
  });
  const toolServer = serve({
    port: env.port,
    portToken: env.portToken,
    poke: () => tools.poke(),
    health: () => tools.health(),
    tool: (name, args, driver) => tools.call(name, args, driver),
  });
  log(`listening on ${toolServer.port}, in tools mode`);
  const stopTools = async (signal: string) => {
    log(`${signal}: stopping`);
    await tools.stop();
    toolServer.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stopTools("SIGTERM"));
  process.once("SIGINT", () => void stopTools("SIGINT"));
  try {
    await tools.start();
    log("started, in tools mode");
  } catch (err) {
    log(`could not start: ${err instanceof Error ? err.message : err}`);
    process.exit(fatal(err) ? EXIT_CONFIG : 1);
  }
  // Everything below is the Claude runner's.
  await new Promise<never>(() => {});
}
const here = dirname(fileURLToPath(import.meta.url));
// Beside this file: the source in a checkout, the bundle in the image.
const helperFile = join(
  here,
  import.meta.url.endsWith(".ts") ? "credential.ts" : "git-credential.js",
);

const runner = new Runner({
  api: new HttpRunnerApi({
    baseUrl: env.apiUrl,
    canvasId: env.canvasId,
    token: env.token,
    client,
  }),
  agent: new ClaudeAgent({
    executable: env.claude,
    client: `ponzu-${client}`,
    log: (line) => log(`claude: ${line}`),
    env: agentEnv(process.env),
  }),
  ...(env.asAgent ? { files: agentFiles(env.asAgent, agentEnv(process.env)) } : {}),
  // The repo's dev server is on this machine, so a canvas may load from it.
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
  // What the working state and the thread's steps never say, whatever the agent typed.
  secrets: [env.token, env.portToken, ...secretValues(process.env)],
  // A secret the agent asks for, given mid-turn, goes to its folder as the agent.
  secretWriter: env.asAgent
    ? agentSecretWriter(env.asAgent, agentEnv(process.env))
    : localSecretWriter(join(homedir(), SECRETS_FOLDER)),
  keepSecret: (value) => {
    scrubbed.push(value);
    logSecrets = knownSecrets(scrubbed);
  },
  // A subscription's plan has limits worth reporting; an API key has none (readEnv holds that
  // exactly one of the two is set).
  planLimits: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
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
    // next sandbox's environment brings back, and any given since (read at each save).
    const secrets = scrubbed;
    const work =
      session.repo && session.branch
        ? new GitWork({
            cwd,
            canvasId: session.canvas.id,
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
  // The runner pushes the canvas's branch with the agent's git, so the checkout stays theirs.
  checkoutGit: (cwd) => gitIn(agentShell(undefined, agentEnv(process.env)), env.git ?? "git", cwd),
  // A token goes to git once GitHub's git endpoint honours it for a push (git-token.ts).
  gitProbe: receivePackProbe(),
  log,
  // Each turn's trace, to PostHog, when the API's session says analytics is on.
  // With content on, what the agent saw and said is scrubbed of every secret its environment holds.
  telemetry: (config) => posthogTelemetry(config, { log, secrets: scrubbed, client }),
  event: (name, fields) => log(JSON.stringify({ event: name, canvasId: env.canvasId, ...fields })),
  onFatal: () => {
    server.stop();
    process.exit(EXIT_CONFIG);
  },
});

const server = serve({
  port: env.port,
  portToken: env.portToken,
  poke: () => runner.poke(),
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
