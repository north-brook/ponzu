/*
 * The runner's entry: `bun runner.js` in a design's sandbox, as the ponzu-runner systemd
 * service. README.md has its environment and how to run it elsewhere.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChromiumRenderer } from "@ponzu/render/chromium";
import { ClaudeAgent } from "./agent/sdk.ts";
import { fatal } from "./api/api.ts";
import { HttpRunnerApi } from "./api/http.ts";
import { EnvError, readEnv } from "./env.ts";
import { checkout } from "./repo.ts";
import { Runner } from "./run.ts";
import { serve } from "./server.ts";
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
  }),
  renderer: new ChromiumRenderer(env.chromium ? { executablePath: env.chromium } : {}),
  // The helper names this process's lease, so git of a runner that was superseded gets nothing.
  prepare: (session) =>
    checkout(session, {
      root: env.workRoot,
      helper: `!'${process.execPath}' '${helperFile}' '${session.runnerId}'`,
    }),
  stateDir: env.stateDir,
  log,
  onFatal: () => {
    server.stop();
    process.exit(EXIT_CONFIG);
  },
});

const server = serve({ port: env.port, poke: () => runner.poke(), health: () => runner.health() });
log(`listening on ${server.port}`);

const shutdown = async (signal: string) => {
  log(`${signal}: stopping`);
  await runner.stop();
  server.stop();
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
