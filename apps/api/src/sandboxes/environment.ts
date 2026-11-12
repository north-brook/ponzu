import { randomBytes } from "node:crypto";
import {
  type AgentBlocker,
  createRunnerToken,
  listCanvasSecrets,
  type SandboxRow,
  type WakeContext,
} from "@ponzu/db";
import { encodeRepoSecrets, REPO_SECRETS_VARIABLE, type StartEnv } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { secretBinding, secretNameProblem } from "../environments/secrets.ts";
import { RUNNER_TOKEN_SECONDS } from "./constants.ts";

/*
 * What a canvas's runner starts with (docs/cloud.md, "Environment" and "Credentials"): where the
 * API is, which canvas, a runner token good for that canvas alone and new at every start, the
 * bearer of its public port, the bundle it runs, exactly one Claude credential, the canvas's
 * owner's, and its repo's secrets, packed into one variable that only the agent's side unpacks
 * (`REPO_SECRETS_VARIABLE`). It goes in the env of the one `ponzu-start` command and nowhere
 * else: not the sandbox's own env, which Vercel keeps and every command inherits, not a file,
 * not a log. A sandbox's disk outlives every start; this lives only as long as the runner.
 */

/**
 * What the start command's environment may carry: Ponzu's own cap. Linux refuses one variable
 * of 128 KiB (`argument list too long`, recorded live); a 64 KB command env was accepted.
 */
const ENV_LIMITS = { bytes: 64 * 1024 };

type Claude = NonNullable<WakeContext["claude"]>;

/** Why the canvas's Claude cannot run it now, or null when it can. */
export function claudeProblem(claude: WakeContext["claude"], now: number): AgentBlocker | null {
  if (!claude || claude.status === "revoked" || !claude.encryptedCredential) {
    return "claude_not_connected";
  }
  if (claude.status === "expired" || (claude.expiresAt && claude.expiresAt.getTime() <= now)) {
    return "claude_expired";
  }
  return null;
}

/**
 * Which credential a runner was started with, as the sandbox's row records it: the account and
 * when it was connected, which a new sign-in or a new key changes. Never the credential itself.
 */
export function credentialMark(claude: Pick<Claude, "id" | "connectedAt">): string {
  return `${claude.id}@${claude.connectedAt.toISOString()}`;
}

export interface Environment {
  /** A `StartEnv`, as a command's env takes it. */
  env: Record<string, string>;
  runnerTokenId: string;
  claudeCredential: string;
  /** `PONZU_PORT_TOKEN`, which the row keeps sealed so the API can poke the runner. */
  portToken: string;
}

/** What the port token is sealed to: the canvas's row. */
export function portBinding(canvasId: string) {
  return { column: "sandboxes.encrypted_port_token", row: canvasId };
}

/** Where the API reaches an awake runner, with its port's bearer; null when it has none. */
export async function runnerTarget(
  { vault }: Pick<Deps, "vault">,
  row: Pick<SandboxRow, "canvasId" | "address" | "encryptedPortToken">,
): Promise<{ url: string; token: string } | null> {
  if (!row.address || !row.encryptedPortToken) return null;
  const token = await vault.open(row.encryptedPortToken, portBinding(row.canvasId));
  return { url: row.address, token };
}

/**
 * A new environment for one start of the canvas's runner, with a runner token and a port token
 * made now, and its repo's secrets as they are now.
 */
export async function newEnvironment(
  deps: Pick<Deps, "db" | "vault" | "config" | "log" | "runnerBundle">,
  canvasId: string,
  claude: Claude,
): Promise<Environment> {
  const credential = await deps.vault.open(claude.encryptedCredential!, {
    column: "claude_accounts.encrypted_credential",
    row: claude.id,
  });
  const [token, secrets] = await Promise.all([
    createRunnerToken(deps.db, { canvasId, ttlSeconds: RUNNER_TOKEN_SECONDS }),
    repoSecrets(deps, canvasId),
  ]);
  const portToken = randomBytes(32).toString("base64url");
  const own = {
    PONZU_API_URL: deps.config.sandbox.apiUrl,
    PONZU_CANVAS_ID: canvasId,
    PONZU_RUNNER_TOKEN: token.token,
    PONZU_PORT_TOKEN: portToken,
    PONZU_RUNNER_BUNDLE: deps.runnerBundle().sha256,
  };
  // Exactly one: with both, Claude Code would use the key and bill it without a word.
  const withClaude: StartEnv =
    claude.kind === "api_key"
      ? { ...own, ANTHROPIC_API_KEY: credential }
      : { ...own, CLAUDE_CODE_OAUTH_TOKEN: credential };
  const plain = asEnv(withClaude);
  const packed = packSecrets(deps, canvasId, plain, secrets);
  return {
    env: packed ? { ...plain, [REPO_SECRETS_VARIABLE]: packed } : plain,
    runnerTokenId: token.id,
    claudeCredential: credentialMark(claude),
    portToken,
  };
}

/** A `StartEnv` as a plain map of the variables it sets. */
function asEnv(env: StartEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * The canvas's repo's secrets, opened. Never fails the wake: a name that is not allowed (one
 * stored before it was reserved) or a value the vault cannot open (sealed with a key since
 * retired) is left out and logged, by count, and the runner starts without it.
 */
async function repoSecrets(
  deps: Pick<Deps, "db" | "vault" | "log">,
  canvasId: string,
): Promise<[name: string, value: string][]> {
  const sealed = await listCanvasSecrets(deps.db, canvasId);
  const opened = await Promise.all(
    sealed.map(async ({ repoId, name, encryptedValue }) => {
      if (secretNameProblem(name)) return null;
      try {
        return [name, await deps.vault.open(encryptedValue, secretBinding(repoId, name))] as [
          string,
          string,
        ];
      } catch {
        return null;
      }
    }),
  );
  const kept = opened.filter((entry) => entry !== null);
  if (kept.length < sealed.length) {
    deps.log.warn("repo_secrets_skipped", { canvasId, skipped: sealed.length - kept.length });
  }
  return kept;
}

/**
 * The secrets as `REPO_SECRETS_VARIABLE` carries them, in the order they were read (by name),
 * as many as fit beside Ponzu's own variables in `ENV_LIMITS`; the rest are left out and
 * logged. Null when there are none. The API keeps a repo's secrets inside this on the way in
 * (`SECRET_LIMITS`), so this only bites when the limits change.
 */
function packSecrets(
  deps: Pick<Deps, "log">,
  canvasId: string,
  own: Record<string, string>,
  secrets: [name: string, value: string][],
): string | null {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const room = Object.entries(own).reduce(
    (left, [name, value]) => left - bytes(name) - bytes(value),
    ENV_LIMITS.bytes - bytes(REPO_SECRETS_VARIABLE),
  );
  const fitting: [string, string][] = [];
  let used = 0;
  for (const secret of secrets) {
    // `NAME:base64`, and a comma before every entry but the first.
    const size = encodeRepoSecrets([secret]).length + (fitting.length > 0 ? 1 : 0);
    if (used + size > room) continue;
    fitting.push(secret);
    used += size;
  }
  const left = secrets.length - fitting.length;
  if (left > 0) deps.log.warn("repo_secrets_over_limit", { canvasId, skipped: left });
  return fitting.length > 0 ? encodeRepoSecrets(fitting) : null;
}
