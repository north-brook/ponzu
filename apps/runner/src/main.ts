/*
 * The runner's entry: `bun runner.js` in a design's sandbox, as the ponzu-runner systemd
 * service. README.md has its environment and how to run it elsewhere.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumRenderer } from "@ponzu/render/chromium";
import { ClaudeAgent } from "./agent/sdk.ts";
import { fatal } from "./api/api.ts";
import { HttpRunnerApi } from "./api/http.ts";
import { agentEnv, EnvError, readEnv } from "./env.ts";
import { agentFiles } from "./files.ts";
import { checkout } from "./repo.ts";
import { Runner } from "./run.ts";
import { serve, serveCredentials } from "./server.ts";
import { VERSION } from "./version.ts";

/**
 * What a restart will not mend (configuration, a revoked token, a newer runner holding the
 * lease): systemd is told not to try (RestartPreventExitStatus).
 */
const EXIT_CONFIG = 78;
/** The Claude Code the sandbox image installs. */
const IMAGE_CLAUDE = "/usr/local/bin/claude";

const log = (message: string) => console.error(`[runner] ${message}`);

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
  flush: () => void spawn("sync", { stdio: "ignore" }).on("error", (err) => log(`sync: ${err}`)),
  log,
  onFatal: () => {
    server.stop();
    process.exit(EXIT_CONFIG);
  },
});

const server = serve({ port: env.port, poke: () => runner.poke(), health: () => runner.health() });
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
