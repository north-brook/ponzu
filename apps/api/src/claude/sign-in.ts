import {
  type ClaudeAccount,
  consumeAuthState,
  getAuthState,
  openClaudeSignIn,
  setClaudeSignInSandbox,
} from "@ponzu/db";
import { SandboxError } from "@ponzu/sandbox";
import { ApiError, UpstreamError } from "../http/errors.ts";
import { type ClaudeDeps, connectClaude } from "./accounts.ts";
import { SIGN_IN_DRIVER } from "./driver.ts";

/*
 * Signing in with a Claude subscription (docs/cloud.md, "Credentials"; the spike's two
 * setup-token scripts). Claude Code's own `claude setup-token` does the sign-in, in a utility
 * sandbox made for it alone with no credential at all: it prints a claude.ai address, the
 * person approves there and claude.ai shows them a code, and the code pasted back makes Claude
 * Code print a one-year token. The sandbox cannot be reached by claude.ai's redirect, which is
 * why the code is pasted.
 *
 *   start    a utility sandbox, the sign-in started in it, and its address handed back
 *   finish   the code written into the sandbox as a file, the token read back as one, sealed
 *            in the vault as the person's Claude, and the sandbox destroyed
 *
 * The code and the token never go into a command, a log or an answer. A sign-in is good for
 * ten minutes and for one code; the minute's sweep destroys the sandboxes of the ones
 * abandoned (`sweepSignIns`).
 */

/** How long a sign-in waits for its code. */
const SIGN_IN_MS = 10 * 60_000;
/** The utility sandbox stops by itself after this, whatever happens to the API. */
const SANDBOX_SECONDS = 15 * 60;
const WAKE_TIMEOUT_MS = 60_000;
const DRIVER = ".st/driver.sh";
/** The label every sign-in's sandbox carries, with `expires`: when it may be destroyed. */
const SIGN_IN_SANDBOX = { ponzu: "claude-sign-in" } as const;
/** How many sign-ins a person may start in an hour. */
const SIGN_INS_PER_HOUR = 5;
/** A subscription token, as claude.ai issues them. */
const TOKEN = /^sk-ant-oat\d+-[A-Za-z0-9_-]{20,}$/;
/** What `claude setup-token` says when it turns a code away. */
const REFUSED = /OAuth error|Invalid code|wasn't accepted/;

export interface StartedSignIn {
  id: string;
  authorizeUrl: string;
  expiresAt: Date;
}

/** The labels of this database's sign-in sandboxes (`SandboxConfig.scope`). */
function signInSandboxes(deps: Pick<ClaudeDeps, "config">): Record<string, string> {
  return { ...SIGN_IN_SANDBOX, scope: deps.config.sandbox.scope };
}

/**
 * Start a sign-in and answer where the person approves it. It replaces any they had open, and
 * its sandbox with it; a person starts at most `SIGN_INS_PER_HOUR` an hour, since each is a
 * machine Ponzu pays for.
 */
export async function startSignIn(deps: ClaudeDeps, userId: string): Promise<StartedSignIn> {
  const { sandbox, clock, db } = deps;
  const expiresAt = new Date(clock.now() + SIGN_IN_MS);
  const opened = await openClaudeSignIn(db, {
    userId,
    now: new Date(clock.now()),
    expiresAt,
    perHour: SIGN_INS_PER_HOUR,
  });
  if (!opened) {
    throw new ApiError(
      429,
      "rate_limited",
      "You've started signing in to Claude several times this hour. Try again later.",
    );
  }
  const { id, replaced } = opened;
  for (const old of replaced) deps.background("claude_sign_in", sandbox.destroy(old));

  let sandboxId: string | null = null;
  try {
    const created = await provider(() =>
      sandbox.create({
        idempotencyKey: `claude-sign-in-${id}`,
        name: "claude-sign-in",
        labels: { ...signInSandboxes(deps), expires: String(expiresAt.getTime()) },
        // No environment at all: an API key or an older token would change who signs in.
        commandHistory: false,
        autoStopSeconds: SANDBOX_SECONDS,
      }),
    );
    const made = created.sandbox.id;
    sandboxId = made;
    if (!(await setClaudeSignInSandbox(db, { id, sandboxId: made }))) {
      throw new ApiError(409, "claude_sign_in_used", "A newer sign-in replaced this one.");
    }
    const url = await provider(async () => {
      await sandbox.ensureAwake(made, { timeoutMs: WAKE_TIMEOUT_MS });
      await sandbox.writeFile(made, DRIVER, SIGN_IN_DRIVER);
      const started = await sandbox.exec(made, `bash ~/${DRIVER} start`, { timeoutSeconds: 45 });
      return /^URL=(https:\/\/\S+)$/m.exec(started.stdout)?.[1] ?? null;
    });
    if (!url) throw new UpstreamError("sandbox", "claude setup-token printed no address.");
    deps.log.info("claude_sign_in_started", { userId, signInId: id });
    return { id, authorizeUrl: url, expiresAt };
  } catch (error) {
    await consumeAuthState(db, { id, kind: "claude_sign_in", now: new Date(clock.now()) });
    if (sandboxId) deps.background("claude_sign_in", sandbox.destroy(sandboxId));
    throw error;
  }
}

/** Finish a sign-in with the code claude.ai showed, and connect the subscription it signs in. */
export async function finishSignIn(
  deps: ClaudeDeps,
  userId: string,
  { id, code }: { id: string; code: string },
): Promise<ClaudeAccount> {
  const { clock, sandbox } = deps;
  // claude.ai's code is two halves around a `#`; without one, Claude Code would only ask again.
  if (!code.includes("#")) {
    throw new ApiError(400, "claude_code_invalid", "That code isn't complete. Copy all of it.");
  }
  const sandboxId = await takeSignIn(deps, userId, id);
  try {
    const token = await provider(async () => {
      await sandbox.writeFile(sandboxId, ".st/code", code);
      const pasted = await sandbox.exec(sandboxId, `bash ~/${DRIVER} code`, {
        timeoutSeconds: 45,
      });
      if (!pasted.stdout.includes("TOKEN_SAVED")) {
        if (REFUSED.test(pasted.stdout)) return null;
        throw new UpstreamError("sandbox", "claude setup-token printed no token.");
      }
      const saved = new TextDecoder().decode(await sandbox.readFile(sandboxId, ".st/token"));
      return { token: saved.trim(), validFor: /valid for ([^\n)]*)/.exec(pasted.stdout)?.[1] };
    });
    if (!token) {
      throw new ApiError(
        400,
        "claude_code_invalid",
        "Claude didn't accept that code. Open sign-in again for a new one.",
      );
    }
    if (!TOKEN.test(token.token)) {
      throw new UpstreamError("sandbox", "claude setup-token printed something else.");
    }
    return await connectClaude(deps, userId, {
      kind: "subscription",
      credential: token.token,
      keyHint: null,
      expiresAt: new Date(clock.now() + lifetime(token.validFor)),
    });
  } finally {
    deps.background("claude_sign_in", sandbox.destroy(sandboxId));
    deps.log.info("claude_sign_in_finished", { userId, signInId: id });
  }
}

/** Give up a sign-in (the person chose another way), and destroy its sandbox. Safe to repeat. */
export async function abandonSignIn(deps: ClaudeDeps, userId: string, id: string): Promise<void> {
  const state = await getAuthState(deps.db, { id, kind: "claude_sign_in", userId });
  if (!state) throw new ApiError(404, "not_found", "There is no such sign-in.");
  await consumeAuthState(deps.db, { id, kind: "claude_sign_in", now: new Date(deps.clock.now()) });
  const sandboxId = state.payload.sandboxId;
  // Without one, its start failed and destroyed what it made.
  if (typeof sandboxId === "string") {
    deps.background("claude_sign_in", deps.sandbox.destroy(sandboxId));
  }
}

/**
 * Destroy the sandboxes of sign-ins past their time: abandoned, or whose destroy failed.
 * Answers how many.
 */
export async function sweepSignIns(
  deps: Pick<ClaudeDeps, "sandbox" | "clock" | "config">,
): Promise<number> {
  const now = deps.clock.now();
  const listed = await deps.sandbox.list({ labels: signInSandboxes(deps) });
  const over = listed.filter(
    (sandbox) => sandbox.state !== "gone" && Number(sandbox.labels.expires) < now,
  );
  await Promise.all(over.map((sandbox) => deps.sandbox.destroy(sandbox.id)));
  return over.length;
}

/**
 * The sign-in's sandbox, once: a code is good for one try, so whatever happens to it the
 * sign-in is used up. Expired, used and unknown sign-ins are told apart for the person.
 */
async function takeSignIn(deps: ClaudeDeps, userId: string, id: string): Promise<string> {
  const now = new Date(deps.clock.now());
  const state = await getAuthState(deps.db, { id, kind: "claude_sign_in", userId });
  if (!state) throw new ApiError(404, "not_found", "There is no such sign-in.");
  const used = new ApiError(
    409,
    "claude_sign_in_used",
    "That sign-in has been used. Open sign-in again for a new code.",
  );
  if (state.consumedAt) throw used;
  if (state.expiresAt <= now) {
    throw new ApiError(410, "claude_sign_in_expired", "That code has expired.");
  }
  if (!(await consumeAuthState(deps.db, { id, kind: "claude_sign_in", now }))) throw used;
  return String(state.payload.sandboxId);
}

/** A provider's failure, as the API reports one: Claude could not be reached. */
async function provider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SandboxError) {
      throw new UpstreamError("sandbox", `The sign-in's sandbox failed: ${error.code}`, {
        cause: error,
      });
    }
    throw error;
  }
}

const UNITS: Record<string, number> = {
  year: 365 * 24 * 3600_000,
  month: 30 * 24 * 3600_000,
  week: 7 * 24 * 3600_000,
  day: 24 * 3600_000,
  hour: 3600_000,
};

/** How long `claude setup-token` said its token is valid for ("1 year"); a year if it did not. */
export function lifetime(validFor: string | undefined): number {
  const said = /(\d+)\s*(year|month|week|day|hour)/.exec(validFor ?? "");
  return said ? Number(said[1]) * UNITS[said[2]!]! : UNITS.year!;
}
