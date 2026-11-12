import {
  type ClaudeAccount,
  getClaudeAccountById,
  getRunnerContext,
  getSandbox,
  recordClaudeModels,
} from "@ponzu/db";
import type { ModelsHeld, ModelsReport } from "@ponzu/runner/protocol";
import type { Deps } from "../deps/index.ts";
import { credentialMark } from "../sandboxes/environment.ts";

/*
 * What Claude Code offers the account a canvas runs on, as its runner reports it (docs/cloud.md,
 * "Models"). Kept on the account, for every canvas and app that asks what it may run on.
 */

/**
 * How often one runner's reports are kept: its first, then at most one in this long. A report
 * past it is answered `kept: false` with 200, never 429, so the runner does not try again; it
 * says it again at its next start of Claude Code.
 */
export const MODELS_REPORT_EVERY_MS = 10 * 60_000;

/**
 * Keep the report, when the runner that made it runs on the credential the account holds now:
 * one started before the person connected another key or subscription says nothing of that one.
 * At most one in `MODELS_REPORT_EVERY_MS` is kept after the runner's first (docs/cloud.md,
 * "Models"); the window is held on the account, so runners on one account share it.
 */
export async function recordReportedModels(
  deps: Pick<Deps, "db" | "clock" | "log">,
  { canvasId, runnerId }: { canvasId: string; runnerId: string },
  report: ModelsReport,
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
    sandbox?.claudeCredential === credentialMark(account);
  const now = deps.clock.now();
  const kept =
    current &&
    (await recordClaudeModels(deps.db, {
      claudeAccountId: account.id,
      connectedAt: account.connectedAt,
      claudeCode: report.claudeCode,
      models: report.models,
      now: new Date(now),
      throttle: { canvasId, runnerId, since: new Date(now - MODELS_REPORT_EVERY_MS) },
    }));
  deps.log.info("claude_models_reported", {
    canvasId,
    claudeCode: report.claudeCode,
    models: report.models.length,
    kept,
    // Why it was not kept: the runner holds a credential since replaced, or it is too soon.
    // (A credential replaced in the same moment as the statement reads as too soon.)
    ...(kept ? {} : { refused: current ? "too_soon" : "old_credential" }),
  });
  return kept;
}

/** What the account holds of a report, as the runner's session hands it over. */
export function modelsHeld(
  account: Pick<ClaudeAccount, "models" | "modelsReportedAt" | "modelsClaudeCode"> | null,
): ModelsHeld | null {
  if (!account?.models || !account.modelsReportedAt || !account.modelsClaudeCode) return null;
  return {
    claudeCode: account.modelsClaudeCode,
    models: account.models,
    at: account.modelsReportedAt.toISOString(),
  };
}
