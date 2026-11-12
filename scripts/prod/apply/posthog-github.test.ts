import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { infraBeforeLaunch } from "../fixtures/infra.ts";
import { planRulesets, rulesetsArea } from "./github.ts";
import { planPosthog, posthogArea } from "./posthog.ts";
import { applyContext, asSeen, fakeNetwork, Reply, type Routes, written } from "./testing.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const fixture = (path: string) => JSON.parse(readFileSync(join(FIXTURES, path), "utf8"));
const infra = infraBeforeLaunch();

describe("apply posthog", () => {
  const KEY = "phx_posthog-test-key-0123456789";
  const project = fixture("posthog/dev-project.json");
  const routes = (state: Record<string, unknown>): Routes => ({
    "GET /api/projects/728454/": () => state,
    "GET /api/projects/728454/groups_types/": project.groupTypes,
    "PATCH /api/projects/728454/": (s: { body: object }) => {
      Object.assign(state, s.body);
      return state;
    },
  });

  test("dev's recorded project already has the four settings: nothing to send", async () => {
    const net = fakeNetwork(routes({ ...project.project }));
    const plan = await planPosthog(
      applyContext("dev", { POSTHOG_PERSONAL_API_KEY: KEY }, net.fetch),
    );
    expect(plan.changes).toEqual([]);
  });

  test("a setting off: one PATCH of the file's four fields to the app host, exactly", async () => {
    const net = fakeNetwork(routes({ ...project.project, heatmaps_opt_in: false }));
    const plan = await planPosthog(
      applyContext("dev", { POSTHOG_PERSONAL_API_KEY: KEY }, net.fetch),
    );
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "PATCH",
        url: "https://us.posthog.com/api/projects/728454/",
        body: {
          session_recording_opt_in: true,
          autocapture_exceptions_opt_in: true,
          capture_console_log_opt_in: true,
          heatmaps_opt_in: true,
        },
      },
    ]);
    expect(net.writes()).toEqual([]);
  });

  test("--yes sends it with the key, then the check's settings line is ok", async () => {
    const net = fakeNetwork(routes({ ...project.project, heatmaps_opt_in: false }));
    const ctx = applyContext("dev", { POSTHOG_PERSONAL_API_KEY: KEY }, net.fetch);
    const plan = await planPosthog(ctx);
    await plan.changes[0]!.send();
    expect(written(net.seen)).toEqual(plan.changes.map((c) => asSeen(c.request)));
    expect(net.seen.find((s) => s.method === "PATCH")?.headers.get("authorization")).toBe(
      `Bearer ${KEY}`,
    );
    expect((await posthogArea.verify!(ctx)).map((l) => `${l.status} ${l.id}`)).toEqual([
      "ok posthog.project",
      "ok posthog.settings",
    ]);
  });

  test("production before D8 names no project: nothing is read or sent", async () => {
    const net = fakeNetwork({});
    const plan = await planPosthog(
      applyContext("production", { POSTHOG_PERSONAL_API_KEY: KEY }, net.fetch),
    );
    expect(plan.changes).toEqual([]);
    expect(net.seen).toEqual([]);
  });
});

describe("apply github-rulesets", () => {
  const TOKEN = "ghp_0123456789abcdefghij0123456789";
  const REPO = "/repos/north-brook/ponzu/rulesets";
  const main = fixture("github/ruleset-25478973.json");
  function routes(list: { id: number; name: string }[], details: Record<number, unknown>): Routes {
    const out: Routes = { [`GET ${REPO}`]: () => list };
    for (const [id, body] of Object.entries(details)) out[`GET ${REPO}/${id}`] = () => body;
    return out;
  }

  test("main as recorded matches; cloud is missing: one POST of its file, exactly", async () => {
    const net = fakeNetwork(routes([{ id: main.id, name: main.name }], { [main.id]: main }));
    const plan = await planRulesets(applyContext("dev", { GH_TOKEN: TOKEN }, net.fetch));
    expect(plan.notes).toEqual(['the ruleset "Protect main" already matches its file']);
    expect(plan.changes.map((c) => c.request)).toEqual([
      {
        method: "POST",
        url: `https://api.github.com${REPO}`,
        body: infra["github/ruleset-cloud.json"],
      },
    ]);
    expect(net.writes()).toEqual([]);
  });

  test("a drifted ruleset is replaced by id with its file", async () => {
    const drifted = { ...main, enforcement: "evaluate" };
    const net = fakeNetwork(routes([{ id: main.id, name: main.name }], { [main.id]: drifted }));
    const plan = await planRulesets(applyContext("dev", { GH_TOKEN: TOKEN }, net.fetch));
    expect(plan.changes[0]?.request).toEqual({
      method: "PUT",
      url: `https://api.github.com${REPO}/${main.id}`,
      body: infra["github/ruleset-main.json"],
    });
    expect(plan.changes[0]?.says).toContain("it is evaluate, not active");
  });

  test("--yes sends what the dry run printed; read again, both rulesets are their files'", async () => {
    const list = [{ id: main.id, name: main.name }];
    const details: Record<number, unknown> = { [main.id]: main };
    const net = fakeNetwork({
      ...routes(list, details),
      [`GET ${REPO}/7`]: () => details[7],
      [`POST ${REPO}`]: (s: { body: Record<string, unknown> }) => {
        list.push({ id: 7, name: s.body.name as string });
        details[7] = { id: 7, ...s.body };
        return details[7];
      },
    } as Routes);
    const ctx = applyContext("dev", { GH_TOKEN: TOKEN }, net.fetch);
    const plan = await planRulesets(ctx);
    for (const change of plan.changes) await change.send();
    expect(written(net.seen)).toEqual(plan.changes.map((c) => asSeen(c.request)));
    expect((await rulesetsArea.verify!(ctx)).map((l) => `${l.status} ${l.id}`)).toEqual([
      "ok github.ruleset.main",
      "ok github.ruleset.cloud",
    ]);
  });

  test("a ruleset on the second page is found, not created again", async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `other ${i}` }));
    const cloud = { ...infra["github/ruleset-cloud.json"], id: 9 };
    const net = fakeNetwork({
      [`GET ${REPO}`]: (s: { query: string }) =>
        new URLSearchParams(s.query).get("page") === "2"
          ? [
              { id: main.id, name: main.name },
              { id: 9, name: cloud.name },
            ]
          : others,
      [`GET ${REPO}/${main.id}`]: main,
      [`GET ${REPO}/9`]: cloud,
    } as Routes);
    const plan = await planRulesets(applyContext("dev", { GH_TOKEN: TOKEN }, net.fetch));
    expect(plan.changes).toEqual([]);
    expect(plan.notes).toEqual([
      'the ruleset "Protect main" already matches its file',
      'the ruleset "Protect cloud" already matches its file',
    ]);
  });

  test("a refused write says GitHub's status only", async () => {
    const net = fakeNetwork({
      ...routes([{ id: main.id, name: main.name }], { [main.id]: main }),
      [`POST ${REPO}`]: new Reply(403, { message: `token ${TOKEN} lacks admin` }),
    });
    const plan = await planRulesets(applyContext("dev", { GH_TOKEN: TOKEN }, net.fetch));
    await expect(plan.changes[0]!.send()).rejects.toThrow(
      /^GitHub answered 403 for creating "Protect cloud"$/,
    );
  });
});
