import { getClaudeAccountById, getRunnerContext, getSandbox, recordClaudeLimit } from "@ponzu/db";
import type { ClaudeLimitReport } from "@ponzu/runner/protocol";
import { credentialMark } from "../sandboxes/environment.ts";
import { resumeBlocked, type WakeDeps } from "../sandboxes/wake.ts";

/*
 * The Claude plan's limits, as a canvas's runner reports them with its state (docs/cloud.md,
 * "Claude plan limits"). Kept on the Claude account the canvas runs on, which every canvas on it
 * and Settings › Agents read: a plan at its limit waits for everyone until it resets.
 */

/** The furthest off a reported reset is believed: a week's window, and a day of slack. */
export const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;

/**
 * Keep the report, when the runner that made it runs on the credential the account holds now,
 * the rule models follow: a runner started before its owner connected another subscription, or
 * an API key, says nothing of the one there now. A report that the plan's requests go through
 * again lifts the wait of the canvases on the account, so they need not sit out the rest of the
 * reset they were told. Answers whether it was kept.
 */
export async function recordReportedLimit(
  deps: WakeDeps,
  canvasId: string,
  report: ClaudeLimitReport,
): Promise<boolean> {
  const [context, sandbox] = await Promise.all([
    getRunnerContext(deps.db, canvasId),
    getSandbox(deps.db, canvasId),
  ]);
  const accountId = context?.canvas.claudeAccountId;
  const account = accountId ? await getClaudeAccountById(deps.db, accountId) : null;
  const current =
    account !== null &&
    account.status !== "revoked" &&
    account.kind === "subscription" &&
    sandbox?.claudeCredential === credentialMark(account);
  const now = new Date(deps.clock.now());
  const resetsAt = report.resetsAt ? new Date(report.resetsAt) : null;
  const recorded = current
    ? await recordClaudeLimit(deps.db, {
        claudeAccountId: account.id,
        connectedAt: account.connectedAt,
        seen: {
          status: report.status,
          window: report.window,
          // No window of a plan resets further off than a week: a later reset is a mistake (or
          // a sandbox's forgery) that would hold every canvas on the account until someone
          // connected again, so it is taken as no reset at all.
          resetsAt:
            resetsAt && resetsAt.getTime() - now.getTime() <= MAX_RESET_AHEAD_MS ? resetsAt : null,
          utilization: report.utilization,
        },
        now,
      })
    : null;
  const kept = recorded?.kept ?? false;
  deps.log.info("claude_limit_reported", {
    canvasId,
    status: report.status,
    window: report.window,
    resetsAt: report.resetsAt,
    kept,
  });
  if (kept && report.status !== "rejected" && account) {
    deps.background(
      "claude_limit_lifted",
      resumeBlocked(deps, { accountId: account.id, blockers: ["claude_limited"] }).then(() => {}),
    );
  }
  return kept;
}
