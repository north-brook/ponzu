import {
  type AgentBlocker,
  createRunnerToken,
  listDesignSecrets,
  type WakeContext,
} from "@ponzu/db";
import { encodeRepoSecrets, REPO_SECRETS_VARIABLE } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { secretBinding, secretNameProblem } from "../environments/secrets.ts";

/*
 * What a design's sandbox starts with (docs/cloud.md, "Environment" and "Credentials"): where
 * the API is, which design, a runner token good for that design alone, exactly one Claude
 * credential, the design's owner's, and its repo's secrets, packed into one variable that only
 * the agent's side unpacks (`REPO_SECRETS_VARIABLE`). The provider's `env` is the only place
 * any of it goes; none of it is logged, written to a file or put in a command.
 */

/** The port the runner listens on, which the API reaches through the sandbox's address. */
export const RUNNER_PORT = 4600;

/**
 * How long a runner token is good for. A sandbox keeps its environment across sleep and wake,
 * so this outlives any stretch of work; a wake that finds less than a day left starts the
 * sandbox on a new one.
 */
const RUNNER_TOKEN_SECONDS = 30 * 24 * 3600;

/**
 * What boat.dev takes as a sandbox's `env`: 64 KB of names and values, and 100 variables, which
 * Ponzu's own and the one the repo's secrets travel in stay well inside.
 */
const ENV_LIMITS = { bytes: 64 * 1024 };

type Claude = NonNullable<WakeContext["claude"]>;

/** Why the design's Claude cannot run it now, or null when it can. */
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
 * Which credential an environment carries, as the sandbox's row records it: the account and when
 * it was connected, which a new sign-in or a new key changes. Never the credential itself.
 */
export function credentialMark(claude: Claude): string {
  return `${claude.id}@${claude.connectedAt.toISOString()}`;
}

/**
 * Whether the sandbox runs on what it should: the Claude credential the owner has now, and a
 * runner token that is good for a while yet.
 */
export function environmentCurrent(context: WakeContext, claude: Claude): boolean {
  return context.runnerTokenGood && context.sandbox?.claudeCredential === credentialMark(claude);
}

export interface Environment {
  env: Record<string, string>;
  runnerTokenId: string;
  claudeCredential: string;
}

/**
 * A new environment for the design's sandbox, with a runner token issued for it now and its
 * repo's secrets as they are now. A secret changed later reaches the sandbox the next time it
 * starts on a new environment (a cold start), not when it wakes from sleep on this one.
 */
export async function newEnvironment(
  deps: Pick<Deps, "db" | "vault" | "config" | "log">,
  designId: string,
  claude: Claude,
): Promise<Environment> {
  const credential = await deps.vault.open(claude.encryptedCredential!, {
    column: "claude_accounts.encrypted_credential",
    row: claude.id,
  });
  const [token, secrets] = await Promise.all([
    createRunnerToken(deps.db, { designId, ttlSeconds: RUNNER_TOKEN_SECONDS }),
    repoSecrets(deps, designId),
  ]);
  const own = {
    PONZU_API_URL: deps.config.sandbox.apiUrl,
    PONZU_DESIGN_ID: designId,
    PONZU_RUNNER_TOKEN: token.token,
    // Exactly one: with both, Claude Code would use the key and bill it without a word.
    [claude.kind === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"]: credential,
  };
  const packed = packSecrets(deps, designId, own, secrets);
  return {
    env: packed ? { ...own, [REPO_SECRETS_VARIABLE]: packed } : own,
    runnerTokenId: token.id,
    claudeCredential: credentialMark(claude),
  };
}

/**
 * The design's repo's secrets, opened. Never fails the wake: a name that is not allowed (one
 * stored before it was reserved) or a value the vault cannot open (sealed with a key since
 * retired) is left out and logged, by count, and the sandbox starts without it.
 */
async function repoSecrets(
  deps: Pick<Deps, "db" | "vault" | "log">,
  designId: string,
): Promise<[name: string, value: string][]> {
  const sealed = await listDesignSecrets(deps.db, designId);
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
    deps.log.warn("repo_secrets_skipped", { designId, skipped: sealed.length - kept.length });
  }
  return kept;
}

/**
 * The secrets as `REPO_SECRETS_VARIABLE` carries them, in the order they were read (by name),
 * as many as fit beside Ponzu's own variables in what the provider takes; the rest are left out
 * and logged. Null when there are none. The API keeps a repo's secrets inside this on the way
 * in (`SECRET_LIMITS`), so this only bites when the limits change.
 */
function packSecrets(
  deps: Pick<Deps, "log">,
  designId: string,
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
  if (left > 0) deps.log.warn("repo_secrets_over_limit", { designId, skipped: left });
  return fitting.length > 0 ? encodeRepoSecrets(fitting) : null;
}
