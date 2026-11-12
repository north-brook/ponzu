/**
 * `apply.ts neon`: the environment's branch as infra/neon.json says, through
 * `@neondatabase/api-client`: the read-write compute (updateProjectEndpoint), the project's
 * point-in-time history (updateProject), the backup schedule (setSnapshotSchedule) and branch
 * protection (updateProjectBranch). Realtime is the founder's to turn on (D3), so it is a note.
 *
 * What is live is read with the check's own reader (checks/neon.ts), plus the branch's and the
 * compute's ids, which the writes need and the check drops.
 */
import { findings } from "../checks/finding.ts";
import {
  evaluateNeon,
  fetchNeon,
  listBranches,
  NEON_API,
  neonClient,
  neonDesired,
  pickBranch,
  plainError,
} from "../checks/neon.ts";
import { type ApplyArea, type ApplyContext, type Change, type Plan, pick } from "./area.ts";

/** Runs one SDK write; an error says only Neon's status, never the request or its key. */
async function write(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    throw plainError(error);
  }
}

export async function planNeon(ctx: ApplyContext): Promise<Plan> {
  const desired = neonDesired(ctx);
  const settings = desired.settings;
  if (!desired.branch) {
    return { notes: [`infra names no Neon branch for ${ctx.env} yet`], changes: [] };
  }
  const projectId = ctx.credentials.NEON_PROJECT_ID as string;
  const api = neonClient(ctx);
  const observed = await fetchNeon(ctx, desired);
  if (!observed.branch) {
    return {
      notes: [`the branch ${desired.branch} does not exist; apply does not make branches`],
      changes: [],
    };
  }
  let branchId: string;
  let endpointId: string | null;
  try {
    const branch = pickBranch(await listBranches(api, projectId), desired.branch);
    branchId = branch?.id as string;
    const { data } = await api.listProjectBranchEndpoints(projectId, branchId);
    endpointId = data.endpoints.find((e) => e.type === "read_write")?.id ?? null;
  } catch (error) {
    throw plainError(error);
  }
  const notes: string[] = [];
  const changes: Change[] = [];
  const url = (path: string) => `${NEON_API}/projects/${projectId}${path}`;
  const name = observed.branch.name;

  if (settings.realtime && !observed.realtime?.enabled) {
    notes.push(`Realtime is off on ${name}; turn it on in Neon (founder step D3), apply does not`);
  }

  if (settings.compute) {
    const want = settings.compute;
    const got = observed.compute;
    if (!got || !endpointId) {
      notes.push(`${name} has no read-write compute; apply does not make one`);
    } else if (
      got.suspendTimeoutSeconds !== want.suspendTimeoutSeconds ||
      got.minCu !== want.autoscalingLimitMinCu ||
      got.maxCu !== want.autoscalingLimitMaxCu
    ) {
      const body = {
        endpoint: {
          suspend_timeout_seconds: want.suspendTimeoutSeconds,
          autoscaling_limit_min_cu: want.autoscalingLimitMinCu,
          autoscaling_limit_max_cu: want.autoscalingLimitMaxCu,
        },
      };
      const id = endpointId;
      changes.push({
        says: `${name}'s compute sleeps after ${got.suspendTimeoutSeconds} s (0 is Neon's default) and scales ${got.minCu} to ${got.maxCu} CU; make it ${want.suspendTimeoutSeconds} and ${want.autoscalingLimitMinCu} to ${want.autoscalingLimitMaxCu}`,
        request: { method: "PATCH", url: url(`/endpoints/${id}`), body },
        send: () => write(() => api.updateProjectEndpoint(projectId, id, body)),
      });
    } else {
      notes.push(`${name}'s compute already matches`);
    }
  }

  if (settings.historyRetentionSeconds !== undefined) {
    const want = settings.historyRetentionSeconds;
    const got = observed.historyRetentionSeconds;
    if (got === null || got < want) {
      const body = { project: { history_retention_seconds: want } };
      changes.push({
        says: `point-in-time history keeps ${got ?? "an unknown number of"} s, less than ${want}`,
        request: { method: "PATCH", url: url(""), body },
        send: () => write(() => api.updateProject(projectId, body)),
      });
    } else {
      notes.push(`point-in-time history keeps ${got} s, at least ${want}`);
    }
  }

  if (settings.backupSchedule) {
    const want = settings.backupSchedule.map((s) => ({
      frequency: s.frequency,
      hour: s.hour,
      retention_seconds: s.retentionSeconds,
    }));
    const got = (observed.schedule ?? []).map((s) => ({
      frequency: s.frequency,
      hour: s.hour,
      retention_seconds: s.retentionSeconds,
    }));
    const key = (items: typeof want | typeof got) =>
      JSON.stringify(items.map((i) => JSON.stringify(i)).sort());
    if (key(want) !== key(got)) {
      const body = { schedule: want };
      changes.push({
        says: `${name}'s backup schedule is ${got.length ? JSON.stringify(got) : "empty"}; make it infra/neon.json's (a paid plan, founder step D1)`,
        request: { method: "PUT", url: url(`/branches/${branchId}/backup_schedule`), body },
        send: () => write(() => api.setSnapshotSchedule(projectId, branchId, body)),
      });
    } else {
      notes.push(`${name}'s backup schedule already matches`);
    }
  }

  if (settings.protected !== undefined) {
    if (observed.branch.protected !== settings.protected) {
      const body = { branch: { protected: settings.protected } };
      changes.push({
        says: `${name} is ${observed.branch.protected ? "" : "not "}a protected branch; make it ${settings.protected ? "" : "not "}protected`,
        request: { method: "PATCH", url: url(`/branches/${branchId}`), body },
        send: () => write(() => api.updateProjectBranch(projectId, branchId, body)),
      });
    } else {
      notes.push(`${name}'s protection already matches`);
    }
  }
  if (!changes.length && !notes.length) notes.push(`infra/neon.json asks nothing more of ${name}`);
  return { notes, changes };
}

/** The lines `apply neon` can make right. Realtime is the founder's, and a snapshot needs a day. */
const NEON_LINES = [
  "neon.branch",
  "neon.compute",
  "neon.history",
  "neon.backups",
  "neon.protected",
];

export const neonArea: ApplyArea = {
  name: "neon",
  needs: ["NEON_API_KEY", "NEON_PROJECT_ID"],
  plan: planNeon,
  async verify(ctx) {
    const desired = neonDesired(ctx);
    const lines = pick(evaluateNeon(desired, await fetchNeon(ctx, desired)), NEON_LINES);
    return lines.length ? lines : [findings("neon").ok("branch", "nothing to check")];
  },
};
