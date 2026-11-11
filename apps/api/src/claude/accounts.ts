import {
  type ClaudeAccount,
  claudeAccountIdFor,
  connectClaudeAccount,
  disconnectClaudeAccount,
  getLiveSandbox,
  setClaudeBlocker,
} from "@ponzu/db";
import type { Deps } from "../deps/index.ts";
import { putToSleep } from "../sandboxes/sweep.ts";
import { startWake } from "../sandboxes/wake.ts";

/*
 * A person's own Claude (docs/cloud.md, "Credentials"): sealed in the vault, bound to its row,
 * and opened only to go into a sandbox's environment. Connecting lets the person's designs that
 * were waiting for Claude run; disconnecting destroys the credential and stops what runs on it.
 */

export type ClaudeDeps = Pick<
  Deps,
  "db" | "clock" | "vault" | "github" | "log" | "sandbox" | "poke" | "config" | "background"
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
    return account;
  }
  throw new Error("The Claude account kept changing while it was being stored.");
}

/**
 * Destroy the person's credential. Their designs say they wait for Claude, and the sandboxes
 * awake on it are stopped. Safe to repeat.
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
  deps.log.info("claude_disconnected", { userId, designs: blocked.length });
  deps.background(
    "claude_disconnected",
    Promise.all(
      blocked.map(async ({ id }) => {
        const sandbox = await getLiveSandbox(db, id);
        if (sandbox?.state === "awake") await putToSleep(deps, sandbox);
      }),
    ),
  );
}
