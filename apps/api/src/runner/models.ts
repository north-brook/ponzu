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
 * What Claude Code offers the account a design runs on, as its runner reports it (docs/cloud.md,
 * "Models"). Kept on the account, for every design and app that asks what it may run on.
 */

/**
 * Keep the report, when the runner that made it runs on the credential the account holds now:
 * one started before the person connected another key or subscription says nothing of that one.
 */
export async function recordReportedModels(
  deps: Pick<Deps, "db" | "clock" | "log">,
  designId: string,
  report: ModelsReport,
): Promise<boolean> {
  const [context, sandbox] = await Promise.all([
    getRunnerContext(deps.db, designId),
    getSandbox(deps.db, designId),
  ]);
  const accountId = context?.design.claudeAccountId;
  const account = accountId ? await getClaudeAccountById(deps.db, accountId) : null;
  const current =
    account !== null &&
    account.status !== "revoked" &&
    sandbox?.claudeCredential === credentialMark(account);
  const kept =
    current &&
    (await recordClaudeModels(deps.db, {
      claudeAccountId: account.id,
      connectedAt: account.connectedAt,
      claudeCode: report.claudeCode,
      models: report.models,
      now: new Date(deps.clock.now()),
    }));
  deps.log.info("claude_models_reported", {
    designId,
    claudeCode: report.claudeCode,
    models: report.models.length,
    kept,
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
