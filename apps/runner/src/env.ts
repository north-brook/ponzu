import { homedir } from "node:os";
import { join } from "node:path";
import { decodeRepoSecrets, REPO_SECRETS_VARIABLE } from "./api/protocol.ts";

/** The environment the runner starts with, read and checked once. */
export interface RunnerEnv {
  apiUrl: string;
  designId: string;
  token: string;
  /** The port `/poke` and `/health` listen on. */
  port: number;
  /** Where checkouts live. */
  workRoot: string;
  /** Where the runner keeps what it needs across restarts. */
  stateDir: string;
  /** The socket git's credential helper asks the runner on. */
  gitSocket: string;
  /** The `claude` binary. Unset, the SDK runs its own copy. */
  claude?: string;
  /** The `git` checkouts run. Unset, the one on the PATH. */
  git?: string;
  /** A Chromium for screenshots. Unset, the renderer looks for one. */
  chromium?: string;
}

export class EnvError extends Error {
  override name = "EnvError";
}

/**
 * What only the runner may hold. Claude Code, its tools and the checkout's git run without
 * them: the agent asks the runner for what it needs (git's credential, over `gitSocket`).
 */
const RUNNER_ONLY = ["PONZU_RUNNER_TOKEN"];

export function readEnv(env: NodeJS.ProcessEnv): RunnerEnv {
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new EnvError(`${name} is not set.`);
    return value;
  };
  // Claude Code takes the API key over the OAuth token when it has both, without a word, and
  // bills the key's account for a design whose owner meant their own plan.
  const credentials = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].filter((name) => env[name]);
  if (credentials.length !== 1) {
    throw new EnvError(
      credentials.length
        ? "Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set. Set exactly one: with both, Claude Code bills the API key."
        : "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.",
    );
  }
  const port = Number(env.PONZU_RUNNER_PORT ?? 4600);
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new EnvError("PONZU_RUNNER_PORT is not a port.");
  const home = env.HOME ?? homedir();
  const stateDir = env.PONZU_STATE_DIR ?? join(home, ".ponzu");
  return {
    apiUrl: need("PONZU_API_URL"),
    designId: need("PONZU_DESIGN_ID"),
    token: need("PONZU_RUNNER_TOKEN"),
    port,
    workRoot: env.PONZU_WORK_ROOT ?? join(home, "work"),
    stateDir,
    gitSocket: env.PONZU_GIT_SOCKET ?? join(stateDir, "git.sock"),
    ...(env.PONZU_CLAUDE ? { claude: env.PONZU_CLAUDE } : {}),
    ...(env.PONZU_GIT ? { git: env.PONZU_GIT } : {}),
    ...(env.PONZU_CHROMIUM ? { chromium: env.PONZU_CHROMIUM } : {}),
  };
}

/**
 * The environment the agent's side runs in: the repo's secrets, unpacked from the one variable
 * they came in, under the runner's own, without what only the runner holds. A secret never
 * replaces a variable the runner has: the API refuses those names, and this is the second lock.
 */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...decodeRepoSecrets(env[REPO_SECRETS_VARIABLE]), ...env };
  for (const name of [...RUNNER_ONLY, REPO_SECRETS_VARIABLE]) delete out[name];
  return out;
}
