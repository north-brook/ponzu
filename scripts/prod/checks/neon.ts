/**
 * The Neon branch an environment's database lives on, against `infra/neon.json`: Realtime on and
 * at the URL infra names, and, where infra asks for them (production), the compute that never
 * sleeps, the project's point-in-time history, the daily backup schedule with a snapshot taken in
 * the last 26 hours, and branch protection.
 *
 * Read through `@neondatabase/api-client` (getProject, listProjectBranches,
 * listProjectBranchEndpoints, getSnapshotSchedule, listSnapshots) and, for Realtime, which the
 * SDK does not cover, the same REST path `apps/api/scripts/neon.ts` uses. Every call is a GET.
 * Nothing asks for a connection string, a password or Realtime's secret.
 *
 * Dev and production share one Neon project (production is its default branch), so the project's
 * history setting is the same for both; only production's neon.json asks for it.
 */
import { createApiClient } from "@neondatabase/api-client";
import { z } from "zod";
import type { EnvironmentName, Neon } from "../desired.ts";
import { type CheckContext, type Finding, findings, list, type Section } from "./finding.ts";

export const NEON_API = "https://console.neon.tech/api/v2";
/** A daily schedule leaves at most a day between snapshots; two hours of slack for its run. */
export const SNAPSHOT_WITHIN_HOURS = 26;

// --- desired ------------------------------------------------------------------------------------

type NeonEnvironment = Neon["environments"]["dev"];

export interface NeonDesired {
  env: EnvironmentName;
  /** A child branch's name, `@default` for the project's default branch, or `null`: not set yet. */
  branch: string | null;
  /** infra/environments.json's realtimeUrl; `null` until the founder sends it (D3). */
  realtimeUrl: string | null;
  settings: NeonEnvironment;
}

export function neonDesired(ctx: Pick<CheckContext, "env" | "infra">): NeonDesired {
  const environment = ctx.infra["environments.json"].environments[ctx.env];
  return {
    env: ctx.env,
    branch: environment.neonBranch,
    realtimeUrl: environment.realtimeUrl,
    settings: ctx.infra["neon.json"].environments[ctx.env],
  };
}

// --- observed -----------------------------------------------------------------------------------

/**
 * What the check keeps of Neon's answers, in their own field names, ids dropped. The fixtures in
 * fixtures/neon/ are this shape, and `fetchNeon` builds it from the live answers.
 */
export const NeonAnswers = z.object({
  project: z.object({ history_retention_seconds: z.number().nullish() }),
  branches: z.array(z.object({ name: z.string(), default: z.boolean(), protected: z.boolean() })),
  endpoints: z.array(
    z.object({
      type: z.string(),
      host: z.string(),
      suspend_timeout_seconds: z.number(),
      autoscaling_limit_min_cu: z.number(),
      autoscaling_limit_max_cu: z.number(),
      disabled: z.boolean().nullish(),
    }),
  ),
  /** `null`: the plan has no backup schedules, or Neon would not say. */
  schedule: z
    .object({
      schedule: z.array(
        z.object({
          frequency: z.string(),
          hour: z.number().nullish(),
          retention_seconds: z.number().nullish(),
        }),
      ),
    })
    .nullable(),
  /** The branch's own snapshots. */
  snapshots: z.array(
    z.object({ name: z.string(), created_at: z.string(), manual: z.boolean().nullish() }),
  ),
  realtime: z.object({ enabled: z.boolean(), invocation_url: z.string().nullish() }).nullable(),
});
export type NeonAnswers = z.infer<typeof NeonAnswers>;

export interface NeonObserved {
  checkedAt: string;
  historyRetentionSeconds: number | null;
  /** `null`: no branch by that name. */
  branch: null | { name: string; default: boolean; protected: boolean };
  /** The branch's read-write compute; `null` when it has none. */
  compute: null | {
    suspendTimeoutSeconds: number;
    minCu: number;
    maxCu: number;
    disabled: boolean;
  };
  schedule: { frequency: string; hour: number | null; retentionSeconds: number | null }[] | null;
  snapshots: { name: string; createdAt: string }[];
  realtime: { enabled: boolean; url: string | null } | null;
}

/** The branch infra names: `@default` is whichever branch is the project's default. */
export function pickBranch<T extends { name: string; default: boolean }>(
  branches: readonly T[],
  name: string,
): T | null {
  return branches.find((b) => (name === "@default" ? b.default : b.name === name)) ?? null;
}

/** Pure: Neon's answers (live or recorded) as the check compares them. */
export function observeNeon(raw: unknown, branchName: string, checkedAt: string): NeonObserved {
  const answers = NeonAnswers.parse(raw);
  const branch = pickBranch(answers.branches, branchName);
  const rw = answers.endpoints.find((e) => e.type === "read_write");
  return {
    checkedAt,
    historyRetentionSeconds: answers.project.history_retention_seconds ?? null,
    branch: branch
      ? { name: branch.name, default: branch.default, protected: branch.protected }
      : null,
    compute: rw
      ? {
          suspendTimeoutSeconds: rw.suspend_timeout_seconds,
          minCu: rw.autoscaling_limit_min_cu,
          maxCu: rw.autoscaling_limit_max_cu,
          disabled: rw.disabled ?? false,
        }
      : null,
    schedule: answers.schedule
      ? answers.schedule.schedule.map((s) => ({
          frequency: s.frequency,
          hour: s.hour ?? null,
          retentionSeconds: s.retention_seconds ?? null,
        }))
      : null,
    snapshots: answers.snapshots.map((s) => ({ name: s.name, createdAt: s.created_at })),
    realtime: answers.realtime
      ? { enabled: answers.realtime.enabled, url: answers.realtime.invocation_url ?? null }
      : null,
  };
}

/** The SDK, speaking through `ctx.fetch` so tests can answer for Neon. */
export function neonClient(ctx: Pick<CheckContext, "credentials" | "fetch">) {
  return createApiClient({
    apiKey: ctx.credentials.NEON_API_KEY as string,
    adapter: "fetch",
    env: { fetch: ctx.fetch },
  });
}

export type NeonApi = ReturnType<typeof createApiClient>;
type Branch = Awaited<ReturnType<NeonApi["listProjectBranches"]>>["data"]["branches"][number];

/** Every branch of the project, following Neon's cursor. */
export async function listBranches(api: NeonApi, projectId: string): Promise<Branch[]> {
  const out: Branch[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const { data } = await api.listProjectBranches({ projectId, limit: 100, cursor });
    out.push(...data.branches);
    cursor = data.pagination?.next;
    if (!cursor || !data.branches.length) return out;
  }
  throw new Error("Neon kept answering more pages of branches");
}

/** An axios error's HTTP status, if it has one. */
export function statusOf(error: unknown): number | null {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  return typeof status === "number" ? status : null;
}

/** Strips an axios error to its status, so a printed line never carries a request's headers. */
export function plainError(error: unknown): Error {
  const status = statusOf(error);
  return new Error(status ? `Neon answered ${status}` : "Neon could not be reached");
}

export async function fetchNeon(ctx: CheckContext, desired: NeonDesired): Promise<NeonObserved> {
  const checkedAt = ctx.now().toISOString();
  const empty: NeonAnswers = {
    project: {},
    branches: [],
    endpoints: [],
    schedule: null,
    snapshots: [],
    realtime: null,
  };
  if (!desired.branch) return observeNeon(empty, "", checkedAt);
  const projectId = ctx.credentials.NEON_PROJECT_ID as string;
  const api = neonClient(ctx);
  try {
    const [project, all] = await Promise.all([
      api.getProject(projectId),
      listBranches(api, projectId),
    ]);
    const branch = pickBranch(all, desired.branch);
    const answers: NeonAnswers = {
      ...empty,
      project: { history_retention_seconds: project.data.project.history_retention_seconds },
      branches: all.map((b) => ({ name: b.name, default: b.default, protected: b.protected })),
    };
    if (!branch) return observeNeon(answers, desired.branch, checkedAt);
    const [endpoints, schedule, snapshots, realtime] = await Promise.all([
      api.listProjectBranchEndpoints(projectId, branch.id),
      api.getSnapshotSchedule(projectId, branch.id).then(
        (r) => r.data,
        (error) => {
          // A plan without backup schedules answers 4xx; that is "no schedule", not a crash.
          const status = statusOf(error);
          if (status !== null && status >= 400 && status < 500) return null;
          throw error;
        },
      ),
      api.listSnapshots(projectId),
      readRealtime(ctx, projectId, branch.id),
    ]);
    return observeNeon(
      {
        ...answers,
        endpoints: endpoints.data.endpoints,
        schedule,
        snapshots: snapshots.data.snapshots
          .filter((s) => s.source_branch_id === branch.id)
          .map((s) => ({ name: s.name, created_at: s.created_at, manual: s.manual })),
        realtime,
      },
      desired.branch,
      checkedAt,
    );
  } catch (error) {
    throw statusOf(error) !== null || (error as { isAxiosError?: boolean })?.isAxiosError
      ? plainError(error)
      : error;
  }
}

/** `GET /projects/{id}/branches/{branch}/realtime`: never `/realtime/secret`. */
async function readRealtime(
  ctx: CheckContext,
  projectId: string,
  branchId: string,
): Promise<NeonAnswers["realtime"]> {
  const response = await ctx.fetch(
    `${NEON_API}/projects/${projectId}/branches/${branchId}/realtime`,
    {
      headers: {
        authorization: `Bearer ${ctx.credentials.NEON_API_KEY}`,
        accept: "application/json",
      },
    },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Neon answered ${response.status} for the branch's Realtime`);
  }
  const body = z
    .object({ enabled: z.boolean(), invocation_url: z.string().nullish() })
    .parse(await response.json());
  return { enabled: body.enabled, invocation_url: body.invocation_url ?? null };
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("neon");

const APPLY = (env: EnvironmentName) =>
  `bun scripts/prod/apply.ts neon --env ${env}${env === "production" ? " --yes (founder step D3)" : ""}`;

/** `https://host/` and `https://host` are the same Realtime URL. */
const origin = (url: string | null) => (url && URL.canParse(url) ? new URL(url).origin : url);

export function evaluateNeon(desired: NeonDesired, observed: NeonObserved): Finding[] {
  const { env, settings } = desired;
  if (!desired.branch) return [f.pending("branch", `infra names no Neon branch for ${env} yet`)];
  const branch = observed.branch;
  const which =
    desired.branch === "@default"
      ? "the project's default branch"
      : `the branch "${desired.branch}"`;
  if (!branch) {
    return [
      f.fail(
        "branch",
        `${which} does not exist`,
        env === "dev"
          ? "docs/production.md › Neon (dev is a child branch of the project)"
          : undefined,
      ),
    ];
  }
  const out: Finding[] = [];
  if (desired.branch !== "@default" && branch.default) {
    out.push(f.fail("branch", `${which} is the project's default branch, which is production's`));
  } else {
    out.push(f.ok("branch", `${which} (${branch.name}) exists`));
  }

  out.push(evaluateRealtime(desired, observed));

  if (settings.compute) {
    const want = settings.compute;
    const got = observed.compute;
    if (!got) {
      out.push(f.fail("compute", `${branch.name} has no read-write compute`, APPLY(env)));
    } else {
      const wrong: string[] = [];
      if (got.suspendTimeoutSeconds !== want.suspendTimeoutSeconds) {
        wrong.push(
          `it ${describeSuspend(got.suspendTimeoutSeconds)}, not ${describeSuspend(want.suspendTimeoutSeconds)}`,
        );
      }
      if (got.minCu !== want.autoscalingLimitMinCu || got.maxCu !== want.autoscalingLimitMaxCu) {
        wrong.push(
          `it scales ${got.minCu} to ${got.maxCu} CU, not ${want.autoscalingLimitMinCu} to ${want.autoscalingLimitMaxCu}`,
        );
      }
      if (got.disabled) wrong.push("it is disabled");
      out.push(
        wrong.length
          ? f.fail("compute", `${branch.name}'s compute: ${list(wrong)}`, APPLY(env))
          : f.ok(
              "compute",
              `${branch.name}'s compute ${describeSuspend(want.suspendTimeoutSeconds)} and scales ${want.autoscalingLimitMinCu} to ${want.autoscalingLimitMaxCu} CU`,
            ),
      );
    }
  }

  if (settings.historyRetentionSeconds !== undefined) {
    const want = settings.historyRetentionSeconds;
    const got = observed.historyRetentionSeconds;
    out.push(
      got !== null && got >= want
        ? f.ok("history", `point-in-time history keeps ${days(got)} (at least ${days(want)})`)
        : f.fail(
            "history",
            `point-in-time history keeps ${got === null ? "an unknown time" : days(got)}, not ${days(want)}`,
            `${APPLY(env)}; the Neon plan must allow it (founder step D1)`,
          ),
    );
  }

  if (settings.backupSchedule) {
    out.push(...evaluateBackups(desired, observed, settings.backupSchedule));
  }

  if (settings.protected !== undefined) {
    out.push(
      branch.protected === settings.protected
        ? f.ok("protected", `${branch.name} is ${branch.protected ? "" : "not "}a protected branch`)
        : f.fail(
            "protected",
            `${branch.name} is ${branch.protected ? "" : "not "}a protected branch`,
            `${APPLY(env)}; protected branches need a paid plan (founder step D1)`,
          ),
    );
  }
  return out;
}

function evaluateRealtime(desired: NeonDesired, observed: NeonObserved): Finding {
  const name = observed.branch?.name ?? "the branch";
  const fix = "Neon › the branch › Realtime: enable it (founder step D3)";
  if (!desired.settings.realtime) {
    return f.ok("realtime", `infra does not ask for Realtime on ${name}`);
  }
  const realtime = observed.realtime;
  if (!realtime?.enabled) return f.fail("realtime", `Realtime is off on ${name}`, fix);
  if (!desired.realtimeUrl) {
    return f.pending(
      "realtime",
      `Realtime is on for ${name}, but infra/environments.json has no realtimeUrl for ${desired.env} yet`,
      "the founder sends the Realtime URL for infra (founder step D3)",
    );
  }
  return origin(realtime.url) === origin(desired.realtimeUrl)
    ? f.ok("realtime", `Realtime is on for ${name}, at ${origin(desired.realtimeUrl)}`)
    : f.fail(
        "realtime",
        `Realtime on ${name} answers at ${origin(realtime.url) ?? "no URL"}, not ${origin(desired.realtimeUrl)}`,
        "make infra/environments.json's realtimeUrl and the API's NEON_REALTIME_URL the branch's",
      );
}

function evaluateBackups(
  desired: NeonDesired,
  observed: NeonObserved,
  want: NonNullable<NeonEnvironment["backupSchedule"]>,
): Finding[] {
  const { env } = desired;
  const name = observed.branch?.name ?? "the branch";
  const fix = `${APPLY(env)}; backup schedules need a paid plan (founder step D1)`;
  const have = observed.schedule ?? [];
  const line = (s: { frequency: string; hour: number | null; retentionSeconds: number | null }) =>
    `${s.frequency}${s.hour === null ? "" : ` at ${String(s.hour).padStart(2, "0")}:00 UTC`}, kept ${s.retentionSeconds === null ? "an unknown time" : days(s.retentionSeconds)}`;
  const wanted = want.map((s) => line({ ...s }));
  if (!have.length) {
    // Nothing set yet is the founder's step to come, never a pass; and with no schedule, no
    // snapshot is expected either.
    return [
      f.pending(
        "backups",
        observed.schedule
          ? `${name} has no backup schedule`
          : `Neon shows no backup schedule for ${name} (the plan may not offer one)`,
        fix,
      ),
      f.pending(
        "snapshot",
        `no scheduled snapshot of ${name} is expected until it has a schedule`,
        fix,
      ),
    ];
  }
  const got = have.map(line);
  const same = got.length === wanted.length && wanted.every((w) => got.includes(w));
  const out = [
    same
      ? f.ok("backups", `${name} is backed up ${list(wanted)}`)
      : f.fail("backups", `${name} is backed up ${list(got)}, not ${list(wanted)}`, fix),
  ];
  const now = new Date(observed.checkedAt).getTime();
  const latest = observed.snapshots
    .map((s) => new Date(s.createdAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  const hours = latest === undefined ? null : Math.floor((now - latest) / 3_600_000);
  out.push(
    hours !== null && hours < SNAPSHOT_WITHIN_HOURS
      ? f.ok("snapshot", `the latest snapshot of ${name} was taken ${hours} hours ago`)
      : f.fail(
          "snapshot",
          hours === null
            ? `${name} has a schedule but no snapshot`
            : `the latest snapshot of ${name} is ${hours} hours old, more than ${SNAPSHOT_WITHIN_HOURS}`,
          "Neon › the branch › Backup & restore: see why the schedule stopped",
        ),
  );
  return out;
}

/** -1 never sleeps; 0 is Neon's default, which sleeps after five minutes. */
export function describeSuspend(seconds: number): string {
  if (seconds === -1) return "never sleeps";
  if (seconds === 0) return "sleeps after Neon's default five minutes";
  return `sleeps after ${seconds} s idle`;
}

function days(seconds: number): string {
  const d = seconds / 86_400;
  return Number.isInteger(d) ? `${d} day${d === 1 ? "" : "s"}` : `${seconds} s`;
}

export const neonSection: Section<NeonDesired, NeonObserved> = {
  area: "neon",
  needs: ["NEON_API_KEY", "NEON_PROJECT_ID"],
  desired: neonDesired,
  fetchObserved: fetchNeon,
  evaluate: evaluateNeon,
};
