import {
  type ClaudeAccount,
  consumeAuthState,
  getAuthState,
  openClaudeSignIn,
  setClaudeSignInSession,
} from "@ponzu/db";
import { type At, SandboxError, signInSandboxName } from "@ponzu/sandbox";
import { ApiError, UpstreamError } from "../http/errors.ts";
import { type ClaudeDeps, connectClaude } from "./accounts.ts";
import { SIGN_IN_DRIVER } from "./driver.ts";

/*
 * Signing in with a Claude subscription (docs/cloud.md, "Credentials"). Claude Code's own
 * `claude setup-token` does the sign-in, in a utility sandbox made for it alone from the
 * design image, with no credential at all and nothing kept after it: it gives a claude.ai
 * address, the person approves there and claude.ai shows them a code, and the code pasted back
 * makes Claude Code print a one-year token. The sandbox cannot be reached by claude.ai's
 * redirect, which is why the code is pasted.
 *
 *   start    the sandbox up (`pz-<scope>-signin-<id>`, not persistent), its session kept in the
 *            sign-in's payload, the driver written and started, and its address read back
 *   finish   the code written into the sandbox as a file, the token read back as one, sealed
 *            in the vault as the person's Claude, and the sandbox removed
 *
 * Every call after `up()` is pinned to that session. The code and the token never go into a
 * command, a log, a command's output or an answer. A sign-in is good for ten minutes and for one
 * code; the sweep's reconcile removes the sandboxes of the ones abandoned.
 */

/** How long a sign-in waits for its code. */
const SIGN_IN_MS = 10 * 60_000;
/** The utility sandbox's session stops by itself after this, whatever happens to the API. */
const SANDBOX_MS = 15 * 60_000;
const COMMAND_MS = 45_000;
/** Where the driver and what it says live: the image's home for Vercel's user. */
const HOME = "/vercel/.st";
const DRIVER = `${HOME}/driver.sh`;
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

/** The name of a sign-in's sandbox. */
function nameOf(deps: Pick<ClaudeDeps, "config">, id: string): string {
  return signInSandboxName(deps.config.sandbox.scope, id);
}

/** Remove a sign-in's sandbox, later; reconcile catches one that fails. */
function removeLater(deps: ClaudeDeps, id: string): void {
  deps.background("claude_sign_in", deps.sandboxes.remove(nameOf(deps, id)));
}

/**
 * Start a sign-in and answer where the person approves it. It replaces any they had open, and
 * its sandbox with it; a person starts at most `SIGN_INS_PER_HOUR` an hour, since each is a
 * machine Ponzu pays for.
 */
export async function startSignIn(deps: ClaudeDeps, userId: string): Promise<StartedSignIn> {
  const { sandboxes, clock, db } = deps;
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
  for (const old of replaced) removeLater(deps, old);

  const name = nameOf(deps, id);
  try {
    const up = await provider(() =>
      sandboxes.up(name, {
        image: deps.config.sandbox.image,
        persistent: false,
        ports: [],
        timeoutMs: SANDBOX_MS,
      }),
    );
    if (!(await setClaudeSignInSession(db, { id, sessionId: up.sessionId }))) {
      throw new ApiError(409, "claude_sign_in_used", "A newer sign-in replaced this one.");
    }
    const at: At = { name, sessionId: up.sessionId };
    const said = await provider(async () => {
      await sandboxes.writeFile(at, DRIVER, SIGN_IN_DRIVER, { mode: 0o700 });
      await sandboxes.exec(at, { cmd: "bash", args: [DRIVER, "start"], timeoutMs: COMMAND_MS });
      return text(await sandboxes.readFile(at, `${HOME}/start.out`));
    });
    const url = /^URL=(https:\/\/\S+)$/m.exec(said)?.[1] ?? null;
    if (!url) throw new UpstreamError("sandbox", "claude setup-token gave no address.");
    deps.log.info("claude_sign_in_started", { userId, signInId: id });
    return { id, authorizeUrl: url, expiresAt };
  } catch (error) {
    await consumeAuthState(db, { id, kind: "claude_sign_in", now: new Date(clock.now()) });
    removeLater(deps, id);
    throw error;
  }
}

/** Finish a sign-in with the code claude.ai showed, and connect the subscription it signs in. */
export async function finishSignIn(
  deps: ClaudeDeps,
  userId: string,
  { id, code }: { id: string; code: string },
): Promise<ClaudeAccount> {
  const { clock, sandboxes } = deps;
  // claude.ai's code is two halves around a `#`; without one, Claude Code would only ask again.
  if (!code.includes("#")) {
    throw new ApiError(400, "claude_code_invalid", "That code isn't complete. Copy all of it.");
  }
  const sessionId = await takeSignIn(deps, userId, id);
  const at: At = { name: nameOf(deps, id), sessionId };
  try {
    const token = await provider(async () => {
      await sandboxes.writeFile(at, `${HOME}/code`, code, { mode: 0o600 });
      await sandboxes.exec(at, { cmd: "bash", args: [DRIVER, "code"], timeoutMs: COMMAND_MS });
      const said = text(await sandboxes.readFile(at, `${HOME}/code.out`));
      if (!said.includes("TOKEN_SAVED")) {
        if (REFUSED.test(said)) return null;
        throw new UpstreamError("sandbox", "claude setup-token gave no token.");
      }
      const saved = text(await sandboxes.readFile(at, `${HOME}/token`));
      return { token: saved.trim(), validFor: /valid for ([^\n)]*)/.exec(said)?.[1] };
    });
    if (!token) {
      throw new ApiError(
        400,
        "claude_code_invalid",
        "Claude didn't accept that code. Open sign-in again for a new one.",
      );
    }
    if (!TOKEN.test(token.token)) {
      throw new UpstreamError("sandbox", "claude setup-token gave something else.");
    }
    return await connectClaude(deps, userId, {
      kind: "subscription",
      credential: token.token,
      keyHint: null,
      expiresAt: new Date(clock.now() + lifetime(token.validFor)),
    });
  } finally {
    removeLater(deps, id);
    deps.log.info("claude_sign_in_finished", { userId, signInId: id });
  }
}

/** Give up a sign-in (the person chose another way), and remove its sandbox. Safe to repeat. */
export async function abandonSignIn(deps: ClaudeDeps, userId: string, id: string): Promise<void> {
  const state = await getAuthState(deps.db, { id, kind: "claude_sign_in", userId });
  if (!state) throw new ApiError(404, "not_found", "There is no such sign-in.");
  await consumeAuthState(deps.db, { id, kind: "claude_sign_in", now: new Date(deps.clock.now()) });
  removeLater(deps, id);
}

/**
 * The session of the sign-in's sandbox, once: a code is good for one try, so whatever happens to
 * it the sign-in is used up. Expired, used and unknown sign-ins are told apart for the person.
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
  const sessionId = state.payload.sessionId;
  // Without one, its start failed and removed what it made.
  if (typeof sessionId !== "string") throw used;
  return sessionId;
}

function text(bytes: Uint8Array | null): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

/** A sandbox's failure, as the API reports one: Claude could not be reached. */
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
