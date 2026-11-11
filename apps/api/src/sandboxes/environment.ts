import { type AgentBlocker, createRunnerToken, type WakeContext } from "@ponzu/db";
import type { Deps } from "../deps/index.ts";

/*
 * What a design's sandbox starts with (docs/cloud.md, "Environment" and "Credentials"): where
 * the API is, which design, a runner token good for that design alone, and exactly one Claude
 * credential, the design's owner's. The provider's `env` is the only place any of it goes; none
 * of it is logged, written to a file or put in a command.
 */

/** The port the runner listens on, which the API reaches through the sandbox's address. */
export const RUNNER_PORT = 4600;

/**
 * How long a runner token is good for. A sandbox keeps its environment across sleep and wake,
 * so this outlives any stretch of work; a wake that finds less than a day left starts the
 * sandbox on a new one.
 */
const RUNNER_TOKEN_SECONDS = 30 * 24 * 3600;

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

/** A new environment for the design's sandbox, with a runner token issued for it now. */
export async function newEnvironment(
  deps: Pick<Deps, "db" | "vault" | "config">,
  designId: string,
  claude: Claude,
): Promise<Environment> {
  const credential = await deps.vault.open(claude.encryptedCredential!, {
    column: "claude_accounts.encrypted_credential",
    row: claude.id,
  });
  const token = await createRunnerToken(deps.db, { designId, ttlSeconds: RUNNER_TOKEN_SECONDS });
  return {
    env: {
      PONZU_API_URL: deps.config.sandbox.apiUrl,
      PONZU_DESIGN_ID: designId,
      PONZU_RUNNER_TOKEN: token.token,
      // Exactly one: with both, Claude Code would use the key and bill it without a word.
      [claude.kind === "api_key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"]: credential,
    },
    runnerTokenId: token.id,
    claudeCredential: credentialMark(claude),
  };
}
