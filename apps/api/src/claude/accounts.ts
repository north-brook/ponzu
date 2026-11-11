import {
  type ClaudeAccount,
  claudeAccountIdFor,
  connectClaudeAccount,
  disconnectClaudeAccount,
  listDesignsWithSandboxOn,
  setClaudeBlocker,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { putToSleep } from "../sandboxes/stop.ts";
import { startWake } from "../sandboxes/wake.ts";

/*
 * A person's own Claude (docs/cloud.md, "Credentials"): sealed in the vault, bound to its row,
 * and opened only to go into the start command of a design's runner. Connecting lets the person's
 * designs that were waiting for Claude run; disconnecting destroys the credential and puts to
 * sleep every runner that holds it.
 */

export type ClaudeDeps = Pick<
  Deps,
  | "db"
  | "clock"
  | "vault"
  | "github"
  | "log"
  | "sandboxes"
  | "runnerBundle"
  | "poke"
  | "storage"
  | "config"
  | "background"
  | "analytics"
>;

/** What a new credential is. */
export interface NewCredential {
  kind: ClaudeAccount["kind"];
  /** The token or the key. Never logged, never returned. */
  credential: string;
  keyHint: string | null;
  expiresAt: Date | null;
}

const BINDING = "claude_accounts.encrypted_credential";

/**
 * Store the person's credential in place of whatever they had, and wake their designs that
 * were waiting for Claude with something to take up.
 */
export async function connectClaude(
  deps: ClaudeDeps,
  userId: string,
  credential: NewCredential,
): Promise<ClaudeAccount> {
  const { db, vault, clock } = deps;
  // Sealed to the row it goes in, whose id must be known first. Someone connecting at the same
  // moment can make the row under another id; then seal again for that one.
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await claudeAccountIdFor(db, userId);
    const account = await connectClaudeAccount(db, {
      id,
      userId,
      kind: credential.kind,
      encryptedCredential: await vault.seal(credential.credential, { column: BINDING, row: id }),
      keyHint: credential.keyHint,
      expiresAt: credential.expiresAt,
      now: new Date(clock.now()),
    });
    if (!account) continue;
    const unblocked = await setClaudeBlocker(db, { claudeAccountId: id, userId, blocker: null });
    for (const design of unblocked) {
      if (design.pending) deps.background("wake", startWake(deps, design.id, "claude"));
    }
    deps.log.info("claude_connected", { userId, kind: credential.kind, woke: unblocked.length });
    deps.analytics.capture(
      "claude connected",
      { kind: credential.kind, woke_designs: unblocked.filter((d) => d.pending).length },
      { distinctId: userId, workspaceId: null },
    );
    return account;
  }
  throw new Error("The Claude account kept changing while it was being stored.");
}

/**
 * Destroy the person's credential, wherever it is. Their designs say they wait for Claude, and
 * every awake sandbox whose runner was started with it is put to sleep at once: the credential
 * lives only in the running runner's memory (it went in the start command's env, which Vercel
 * does not keep with the sandbox), so an asleep one holds nothing and is left alone. A design
 * waking at this moment is put to sleep by the minute's sweep. Safe to repeat.
 */
export async function disconnectClaude(deps: ClaudeDeps, userId: string): Promise<void> {
  const { db } = deps;
  const accountId = await disconnectClaudeAccount(db, userId);
  if (!accountId) return;
  const blocked = await setClaudeBlocker(db, {
    claudeAccountId: accountId,
    userId,
    blocker: "claude_not_connected",
  });
  const holding = await listDesignsWithSandboxOn(db, { claudeAccountId: accountId, userId });
  deps.log.info("claude_disconnected", {
    userId,
    designs: blocked.length,
    sandboxes: holding.length,
  });
  deps.analytics.capture("claude disconnected", {}, { distinctId: userId, workspaceId: null });
  for (const row of holding) {
    deps.background(
      "claude_disconnected",
      putToSleep(deps, row, "claude_disconnected").then(() => {}),
    );
  }
}
