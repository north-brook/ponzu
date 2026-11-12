import {
  countAppliedMigrations,
  countSealedValues,
  EXPECTED_MIGRATIONS,
  pingDb,
  QueryError,
} from "@ponzu/db";
import { SandboxError, scopePrefix } from "@ponzu/sandbox";
import type { Deps } from "../deps/index.ts";
import { UpstreamError } from "../http/errors.ts";
import { missingEvents, missingPermissions } from "./github-app.ts";

/*
 * The API checks its own dependencies and settings (`GET /v1/cron/selfcheck`, and the cron at
 * minute 7 of every hour): each one is asked the smallest question that proves the key or
 * setting works, on a budget of its own, and all at once.
 *
 * What it answers is safe to print anywhere. `detail` is a word from `SelfcheckDetail` and
 * `missing` names only entries of the API's own lists (`github-app.ts`): nothing an upstream
 * service said, and no value from the environment, is ever put in an answer or a log line.
 */

/** Every check, in the order it is answered. */
export const SELFCHECK_IDS = [
  "database",
  "migrations",
  "realtime",
  "storage_assets",
  "storage_private",
  "workos",
  "github_app",
  "github_webhook",
  "anthropic",
  "sandboxes",
  "vault_old_keys",
  "posthog",
] as const;

export type SelfcheckId = (typeof SELFCHECK_IDS)[number];

/** Every word a check may answer with. */
export const SELFCHECK_DETAILS = [
  /** It did what was asked. */
  "ok",
  /** It answered nothing within the check's budget. */
  "timed_out",
  /** It could not be reached at all. */
  "unreachable",
  /** It answered that the credential is not good (401 or 403, or a key it does not take). */
  "refused",
  /** It answered with some other failure. */
  "failed",
  /** The database has applied fewer migrations than this build has: a deploy came before `db:migrate`. */
  "behind",
  /** The database has applied more migrations than this build has: an older build is running. */
  "ahead",
  /** The App's slug is not `GITHUB_APP_SLUG`. */
  "wrong_slug",
  /** The App lacks a permission the API uses, or holds it at too low a level; see `missing`. */
  "missing_permissions",
  /** The App is not subscribed to an event the API acts on; see `missing`. */
  "missing_events",
  /** The App's webhook does not point at `PONZU_API_URL` + `/v1/github/webhook`. */
  "wrong_url",
  /** The App's webhook does not send json. */
  "wrong_content_type",
  /** The App's webhook does not check TLS. */
  "insecure_ssl",
  /** Values remain sealed with an old vault key; `count` says how many. Run the reseal. */
  "old_keys",
  /** Optional, and set. */
  "configured",
  /** Optional, and not set. */
  "not_configured",
  /** No private bucket is set: archives go in the assets bucket, which `storage_assets` checks. */
  "same_bucket",
] as const;

export type SelfcheckDetail = (typeof SELFCHECK_DETAILS)[number];

export interface SelfcheckResult {
  id: SelfcheckId;
  ok: boolean;
  detail: SelfcheckDetail;
  /** For `vault_old_keys`: how many values are sealed under keys other than the current one. */
  count?: number;
  /** For `github_app`: the permissions or events, from the API's own lists, that it lacks. */
  missing?: string[];
}

/**
 * Checks that say how things stand rather than whether something works. A failed one is
 * answered and logged but not raised as an exception: it is a step left to do, not an outage.
 */
export const INFORMATIONAL: ReadonlySet<SelfcheckId> = new Set(["vault_old_keys", "posthog"]);

/** How long each check has. They run at once, so the whole selfcheck takes about this long. */
export const CHECK_BUDGET_MS = 5_000;

/**
 * A key no object is ever stored under: the HEAD a storage check makes. 404 says the token
 * reads the bucket; 403 says it does not.
 */
export const ABSENT_KEY = "ponzu-selfcheck/absent";

/** What `realtime` seals: a fixed statement with no value in it. Sealing is local and sends nothing. */
const REALTIME_PROBE = { sql: "select 1", params: [] as string[] };

type Outcome = { ok: boolean; detail: SelfcheckDetail; count?: number; missing?: string[] };

const OK: Outcome = { ok: true, detail: "ok" };
const fail = (detail: SelfcheckDetail, extra: Partial<Outcome> = {}): Outcome => ({
  ok: false,
  detail,
  ...extra,
});

type Check = (deps: Deps, signal: AbortSignal) => Promise<Outcome>;

const CHECKS: Record<SelfcheckId, Check> = {
  async database(deps) {
    await pingDb(deps.db);
    return OK;
  },

  async migrations(deps) {
    const applied = await countAppliedMigrations(deps.db);
    if (applied < EXPECTED_MIGRATIONS) return fail("behind");
    if (applied > EXPECTED_MIGRATIONS) return fail("ahead");
    return OK;
  },

  async realtime(deps) {
    await deps.realtime.seal(REALTIME_PROBE);
    return OK;
  },

  async storage_assets(deps) {
    await deps.storage.head(ABSENT_KEY);
    return OK;
  },

  async storage_private(deps) {
    if (deps.archives === deps.storage) return { ok: true, detail: "same_bucket" };
    await deps.archives.head(ABSENT_KEY);
    return OK;
  },

  async workos(deps) {
    await deps.workos.ping();
    return OK;
  },

  async github_app(deps) {
    const app = await deps.github.getApp();
    if (app.slug !== deps.config.githubApp.slug) return fail("wrong_slug");
    const permissions = missingPermissions(app.permissions);
    if (permissions.length > 0) return fail("missing_permissions", { missing: permissions });
    const events = missingEvents(app.events);
    if (events.length > 0) return fail("missing_events", { missing: events });
    return OK;
  },

  async github_webhook(deps) {
    const hook = await deps.github.getHookConfig();
    if (hook.url !== `${deps.config.sandbox.apiUrl}/v1/github/webhook`) return fail("wrong_url");
    if (hook.contentType !== "json") return fail("wrong_content_type");
    if (hook.insecureSsl !== "0") return fail("insecure_ssl");
    return OK;
  },

  async anthropic(deps) {
    return (await deps.anthropic.acceptsOwnKey()) ? OK : fail("refused");
  },

  async sandboxes(deps, signal) {
    await deps.sandboxes.list(scopePrefix(deps.config.sandbox.scope), { signal });
    return OK;
  },

  async vault_old_keys(deps) {
    const { current } = await deps.vault.keyIds();
    const count = (await countSealedValues(deps.db))
      .filter((counted) => counted.keyId !== current)
      .reduce((sum, counted) => sum + counted.count, 0);
    return count === 0 ? { ...OK, count } : fail("old_keys", { count });
  },

  async posthog(deps) {
    return { ok: true, detail: deps.config.posthog ? "configured" : "not_configured" };
  },
};

/** Run every check (or those in `ids`) at once, each on its budget. Never throws. */
export async function runSelfcheck(
  deps: Deps,
  ids: readonly SelfcheckId[] = SELFCHECK_IDS,
): Promise<SelfcheckResult[]> {
  return Promise.all(ids.map(async (id) => ({ id, ...(await runCheck(deps, id)) })));
}

async function runCheck(deps: Deps, id: SelfcheckId): Promise<Outcome> {
  const signal = deps.clock.timeout(CHECK_BUDGET_MS);
  const timedOut = new Promise<Outcome>((resolve) => {
    if (signal.aborted) resolve(fail("timed_out"));
    signal.addEventListener("abort", () => resolve(fail("timed_out")), { once: true });
  });
  const checked = CHECKS[id](deps, signal).catch((error: unknown) => fail(detailOf(error)));
  return Promise.race([checked, timedOut]);
}

/** The word for what went wrong. Reads only a status or a code, never a message. */
export function detailOf(error: unknown): SelfcheckDetail {
  if (error instanceof UpstreamError) {
    if (error.status === undefined) return "unreachable";
    return error.status === 401 || error.status === 403 ? "refused" : "failed";
  }
  if (error instanceof QueryError) return error.unavailable ? "unreachable" : "failed";
  if (error instanceof SandboxError) {
    if (error.code === "unavailable") return "unreachable";
    return "failed";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timed_out";
  }
  return "failed";
}

/** A failed check, as error tracking is handed it: the id and the word, nothing else. */
export class SelfcheckFailed extends Error {
  constructor(
    readonly check: SelfcheckId,
    readonly detail: SelfcheckDetail,
  ) {
    super(`selfcheck_failed ${check}: ${detail}`);
    this.name = "SelfcheckFailed";
  }
}

/**
 * Log every check that failed, and raise each that is not informational as an exception
 * (`selfcheck_failed`, with `check: <id>`): PostHog's error tracking is the alarm.
 */
export function reportSelfcheck(
  deps: Pick<Deps, "log" | "analytics">,
  results: readonly SelfcheckResult[],
): void {
  for (const { id, ok, detail, count } of results) {
    if (ok) continue;
    deps.log.warn("selfcheck_failed", {
      check: id,
      detail,
      ...(count === undefined ? {} : { count }),
    });
    if (!INFORMATIONAL.has(id)) {
      deps.analytics.exception(new SelfcheckFailed(id, detail), { check: id, detail });
    }
  }
}
