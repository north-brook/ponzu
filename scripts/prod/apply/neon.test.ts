import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neonArea, planNeon } from "./neon.ts";
import { applyContext, asSeen, fakeNetwork, Reply, type Routes, written } from "./testing.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "neon");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const PROJECT = "project-id-not-public";
const KEY = "neon-test-key-0123456789";
const API = `https://console.neon.tech/api/v2/projects/${PROJECT}`;
const creds = { NEON_API_KEY: KEY, NEON_PROJECT_ID: PROJECT };

/** Neon answering with a recorded branch: `pick` is the index of the branch read. */
function neon(name: string, pick: number, state = fixture(name)): Routes {
  const p = `/api/v2/projects/${PROJECT}`;
  const br = `br-${pick}`;
  return {
    [`GET ${p}`]: () => ({ project: { id: PROJECT, ...state.project } }),
    [`GET ${p}/branches`]: () => ({
      branches: state.branches.map((b: object, i: number) => ({ ...b, id: `br-${i}` })),
      pagination: {},
    }),
    [`GET ${p}/branches/${br}/endpoints`]: () => ({
      endpoints: state.endpoints.map((e: object) => ({ ...e, id: "ep-rw" })),
    }),
    [`GET ${p}/branches/${br}/backup_schedule`]: () => state.schedule,
    [`GET ${p}/snapshots`]: { snapshots: [] },
    [`GET ${p}/branches/${br}/realtime`]: () => state.realtime,
  };
}

describe("apply neon", () => {
  test("production's recorded default branch: four requests, these bodies exactly", async () => {
    // The default branch ("production") is the fourth in the recording.
    const net = fakeNetwork(neon("dev-default-branch.json", 3));
    const plan = await planNeon(applyContext("production", creds, net.fetch));
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "PATCH",
        url: `${API}/endpoints/ep-rw`,
        body: {
          endpoint: {
            suspend_timeout_seconds: -1,
            autoscaling_limit_min_cu: 0.5,
            autoscaling_limit_max_cu: 2,
          },
        },
      },
      { method: "PATCH", url: API, body: { project: { history_retention_seconds: 604800 } } },
      {
        method: "PUT",
        url: `${API}/branches/br-3/backup_schedule`,
        body: { schedule: [{ frequency: "daily", hour: 7, retention_seconds: 3024000 }] },
      },
      { method: "PATCH", url: `${API}/branches/br-3`, body: { branch: { protected: true } } },
    ]);
    expect(net.writes()).toEqual([]);
  });

  test("dev asks only for Realtime, which is on: nothing to send", async () => {
    const net = fakeNetwork(neon("dev-branch.json", 0));
    const plan = await planNeon(applyContext("dev", creds, net.fetch));
    expect(plan.changes).toEqual([]);
  });

  test("--yes sends what the dry run printed, then the check's lines are ok", async () => {
    const state = fixture("dev-default-branch.json");
    const p = `/api/v2/projects/${PROJECT}`;
    const net = fakeNetwork({
      ...neon("dev-default-branch.json", 3, state),
      [`PATCH ${p}/endpoints/ep-rw`]: (s: { body: { endpoint: Record<string, number> } }) => {
        Object.assign(state.endpoints[0], s.body.endpoint);
        return { endpoint: {}, operations: [] };
      },
      [`PATCH ${p}`]: (s: { body: { project: Record<string, number> } }) => {
        Object.assign(state.project, s.body.project);
        return { project: {}, operations: [] };
      },
      [`PUT ${p}/branches/br-3/backup_schedule`]: (s: { body: unknown }) => {
        state.schedule = s.body;
        return {};
      },
      [`PATCH ${p}/branches/br-3`]: () => {
        state.branches[3].protected = true;
        return { branch: {}, operations: [] };
      },
    } as Routes);
    const ctx = applyContext("production", creds, net.fetch);
    const plan = await planNeon(ctx);
    for (const change of plan.changes) await change.send();
    expect(written(net.seen)).toEqual(plan.changes.map((c) => asSeen(c.request)));
    const lines = await neonArea.verify!(ctx);
    expect(lines.map((l) => `${l.status} ${l.id}`)).toEqual([
      "ok neon.branch",
      "ok neon.compute",
      "ok neon.history",
      "ok neon.backups",
      "ok neon.protected",
    ]);
    expect((await planNeon(ctx)).changes).toEqual([]);
  });

  test("a refused write says Neon's status only", async () => {
    const net = fakeNetwork({
      ...neon("dev-default-branch.json", 3),
      [`PATCH /api/v2/projects/${PROJECT}/endpoints/ep-rw`]: new Reply(403, {
        message: `key ${KEY} may not`,
      }),
    });
    const plan = await planNeon(applyContext("production", creds, net.fetch));
    await expect(plan.changes[0]!.send()).rejects.toThrow(/^Neon answered 403$/);
  });
});
