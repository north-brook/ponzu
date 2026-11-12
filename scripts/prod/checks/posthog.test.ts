import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvironments, loadInfra } from "../desired.ts";
import type { CheckContext, Finding } from "./finding.ts";
import {
  apiHostFor,
  evaluatePosthog,
  fetchPosthog,
  PosthogAnswers,
  type PosthogDesired,
  posthogDesired,
} from "./posthog.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const documented = (): PosthogAnswers =>
  PosthogAnswers.parse(
    JSON.parse(readFileSync(join(FIXTURES, "posthog", "dev-project.json"), "utf8")),
  );
const infra = loadInfra();
const desired = (env: "dev" | "production"): PosthogDesired => posthogDesired({ env, infra });
const byId = (findings: Finding[]) => Object.fromEntries(findings.map((f) => [f.id, f]));
const KEY = "phx_personal-key-0123456789abcdef";

describe("evaluate", () => {
  test("dev's project as documented: every line, exactly", () => {
    expect(evaluatePosthog(desired("dev"), documented())).toEqual([
      {
        id: "posthog.project",
        area: "posthog",
        status: "ok",
        says: 'PostHog project 728454 is "Ponzu Dev"',
      },
      {
        id: "posthog.settings",
        area: "posthog",
        status: "ok",
        says: "project 728454 records sessions, exceptions, console logs and heatmaps as infra/posthog.json says",
      },
      {
        id: "posthog.group-types",
        area: "posthog",
        status: "ok",
        says: "project 728454 has the group type workspace",
      },
    ]);
  });

  test("a setting off fails, naming it and the apply command", () => {
    const answers = documented();
    if (answers.project) answers.project.heatmaps_opt_in = false;
    const f = byId(evaluatePosthog(desired("dev"), answers));
    expect(f["posthog.settings"]).toEqual({
      id: "posthog.settings",
      area: "posthog",
      status: "fail",
      says: "project 728454: heatmaps_opt_in is false, not true",
      fix: "bun scripts/prod/apply.ts posthog --env dev",
    });
  });

  test("no workspace group before the first event is pending; after it, a fail", () => {
    const answers = { ...documented(), groupTypes: [] };
    if (answers.project) answers.project.ingested_event = false;
    expect(byId(evaluatePosthog(desired("dev"), answers))["posthog.group-types"]?.status).toBe(
      "pending",
    );
    if (answers.project) answers.project.ingested_event = true;
    expect(byId(evaluatePosthog(desired("dev"), answers))["posthog.group-types"]?.status).toBe(
      "fail",
    );
  });

  test("production with no project id is pending, never ok", () => {
    expect(evaluatePosthog(desired("production"), { project: null, groupTypes: [] })).toEqual([
      {
        id: "posthog.project",
        area: "posthog",
        status: "pending",
        says: "infra/environments.json names no PostHog project for production yet",
        fix: "founder step D8: create the project, then send the orchestrator its id",
      },
    ]);
  });

  test("a project the key cannot see fails", () => {
    expect(evaluatePosthog(desired("dev"), { project: null, groupTypes: [] })[0]?.status).toBe(
      "fail",
    );
  });

  test("the management API is the region's app host", () => {
    expect(apiHostFor("https://us.i.posthog.com")).toBe("https://us.posthog.com");
    expect(apiHostFor("https://eu.i.posthog.com")).toBe("https://eu.posthog.com");
    expect(apiHostFor("https://ph.example.com")).toBe("https://ph.example.com");
  });
});

// --- fetch, against a fake PostHog --------------------------------------------------------------

function ctx(fetch: typeof globalThis.fetch): CheckContext {
  return {
    env: "dev",
    infra,
    credentials: { POSTHOG_PERSONAL_API_KEY: KEY },
    fetch,
    now: () => new Date("2026-11-12T15:00:00Z"),
    deep: false,
  };
}

describe("fetchPosthog", () => {
  test("reads the project and its group types with GETs, the key only to infra's host", async () => {
    const seen: { url: string; method: string; auth: string | null; redirect?: string }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({
        url,
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      if (url.endsWith("/groups_types/")) {
        return Response.json([{ group_type: "workspace", group_type_index: 0, name_plural: null }]);
      }
      return Response.json({
        id: 728454,
        name: "Ponzu Dev",
        api_token: "phc_public",
        ingested_event: true,
        session_recording_opt_in: true,
        autocapture_exceptions_opt_in: true,
        capture_console_log_opt_in: true,
        heatmaps_opt_in: true,
        recording_domains: [],
      });
    }) as unknown as typeof globalThis.fetch;
    const got = await fetchPosthog(ctx(fetch), desired("dev"));
    expect(got).toEqual(documented());
    expect(seen.map((s) => [s.method, s.url, s.auth, s.redirect])).toEqual([
      ["GET", "https://us.posthog.com/api/projects/728454/", `Bearer ${KEY}`, "error"],
      ["GET", "https://us.posthog.com/api/projects/728454/groups_types/", `Bearer ${KEY}`, "error"],
    ]);
  });

  test("a refusal says the status and the scope, never the key", async () => {
    const fetch = (async () =>
      new Response(`invalid key ${KEY}`, { status: 403 })) as unknown as typeof globalThis.fetch;
    const error = await fetchPosthog(ctx(fetch), desired("dev")).catch((e) => e);
    expect(error.message).toBe(
      "PostHog answered 403 for the project (the personal key needs project:read on this project)",
    );
  });

  test("a 404 project is null, and no group types are asked for", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchPosthog(ctx(fetch), desired("dev"))).toEqual({
      project: null,
      groupTypes: [],
    });
    expect(calls).toBe(1);
  });

  test("production with no project id reads nothing", async () => {
    const fetch = (async () => {
      throw new Error("no network");
    }) as unknown as typeof globalThis.fetch;
    const filled = loadEnvironments(join(FIXTURES, "environments-filled.json"));
    expect(filled.environments.production.posthog.projectId).not.toBeNull();
    expect(await fetchPosthog(ctx(fetch), desired("production"))).toEqual({
      project: null,
      groupTypes: [],
    });
  });
});
