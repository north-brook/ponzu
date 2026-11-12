/**
 * The environment's PostHog project, against `infra/posthog.json`: it exists under the id
 * `environments.json` names, has the settings both projects must have (session recording,
 * exception autocapture, console logs, heatmaps), and, once its first event has come in, has
 * the group type `workspace`. A group type cannot be made ahead of its first event, so before
 * one it is `pending`, never a pass.
 *
 * Read through PostHog's REST API with a personal API key (`POSTHOG_PERSONAL_API_KEY`, read
 * scopes only: project:read): `GET /api/projects/{id}/` and `GET /api/projects/{id}/groups_types/`
 * on the region's app host (`us.posthog.com` for the `us.i.posthog.com` the apps send to). There
 * is no official SDK for PostHog's management API (posthog-node only captures), so this is a
 * plain fetch. Both are GETs.
 *
 * Replay `full` or `private` and AI content are settings of the apps and the API (Vercel env and
 * repository variables), not of the PostHog project, so the Vercel section and the build judge
 * those, not this one.
 */
import { z } from "zod";
import type { EnvironmentName, Infra } from "../desired.ts";
import { type CheckContext, type Finding, findings, list, type Section } from "./finding.ts";

// --- desired ------------------------------------------------------------------------------------

type Settings = Infra["posthog.json"]["project"];

export interface PosthogDesired {
  env: EnvironmentName;
  /** `null` until founder step D8. */
  projectId: number | null;
  /** Where the management API answers: the ingestion host without its `.i`. */
  apiHost: string;
  settings: Settings;
  groupTypes: string[];
}

/** `https://us.i.posthog.com` → `https://us.posthog.com`; a self-hosted host is its own. */
export function apiHostFor(ingestion: string): string {
  const url = new URL(ingestion);
  url.hostname = url.hostname.replace(/^(us|eu)\.i\.posthog\.com$/, "$1.posthog.com");
  return url.origin;
}

export function posthogDesired(ctx: Pick<CheckContext, "env" | "infra">): PosthogDesired {
  const environment = ctx.infra["environments.json"].environments[ctx.env];
  const file = ctx.infra["posthog.json"];
  return {
    env: ctx.env,
    projectId: environment.posthog.projectId,
    apiHost: apiHostFor(environment.posthog.host),
    settings: file.project,
    groupTypes: file.groupTypes,
  };
}

// --- observed -----------------------------------------------------------------------------------

/**
 * What the check keeps of PostHog's answers, in its field names. fixtures/posthog/ is this shape.
 * `project` is `null` when PostHog answered 404 for the id.
 */
export const PosthogAnswers = z.object({
  project: z
    .object({
      name: z.string(),
      /** Whether any event has ever arrived. */
      ingested_event: z.boolean().nullish(),
      session_recording_opt_in: z.boolean().nullish(),
      autocapture_exceptions_opt_in: z.boolean().nullish(),
      capture_console_log_opt_in: z.boolean().nullish(),
      heatmaps_opt_in: z.boolean().nullish(),
    })
    .nullable(),
  groupTypes: z.array(z.object({ group_type: z.string(), group_type_index: z.number() })),
});
export type PosthogAnswers = z.infer<typeof PosthogAnswers>;
export type PosthogObserved = PosthogAnswers;

const SETTING_KEYS = [
  "session_recording_opt_in",
  "autocapture_exceptions_opt_in",
  "capture_console_log_opt_in",
  "heatmaps_opt_in",
] as const satisfies readonly (keyof Settings)[];

export async function fetchPosthog(
  ctx: CheckContext,
  desired: PosthogDesired,
): Promise<PosthogObserved> {
  if (desired.projectId === null) return { project: null, groupTypes: [] };
  const base = `${desired.apiHost}/api/projects/${desired.projectId}`;
  const get = async (path: string, what: string): Promise<unknown> => {
    const response = await ctx.fetch(`${base}${path}`, {
      headers: {
        authorization: `Bearer ${ctx.credentials.POSTHOG_PERSONAL_API_KEY}`,
        accept: "application/json",
      },
      // The key goes only to the host infra names.
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const hint =
        response.status === 401 || response.status === 403
          ? " (the personal key needs project:read on this project)"
          : "";
      throw new Error(`PostHog answered ${response.status} for ${what}${hint}`);
    }
    return response.json();
  };
  const project = await get("/", "the project");
  if (!project) return { project: null, groupTypes: [] };
  const raw = z.record(z.string(), z.unknown()).parse(project);
  const groups = await get("/groups_types/", "the group types");
  return PosthogAnswers.parse({
    project: Object.fromEntries(
      ["name", "ingested_event", ...SETTING_KEYS].map((key) => [key, raw[key] ?? null]),
    ),
    groupTypes: z
      .array(z.record(z.string(), z.unknown()))
      .parse(groups ?? [])
      .map((g) => ({
        group_type: g.group_type,
        group_type_index: g.group_type_index,
      })),
  });
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("posthog");

export function evaluatePosthog(desired: PosthogDesired, observed: PosthogObserved): Finding[] {
  const { env, projectId } = desired;
  if (projectId === null) {
    return [
      f.pending(
        "project",
        `infra/environments.json names no PostHog project for ${env} yet`,
        "founder step D8: create the project, then send the orchestrator its id",
      ),
    ];
  }
  const project = observed.project;
  if (!project) {
    return [
      f.fail(
        "project",
        `PostHog has no project ${projectId} that the key can see`,
        "check infra/environments.json's posthog.projectId and the personal key's projects",
      ),
    ];
  }
  const out: Finding[] = [f.ok("project", `PostHog project ${projectId} is "${project.name}"`)];

  const apply = `bun scripts/prod/apply.ts posthog --env ${env}${env === "production" ? " --yes (founder step D8)" : ""}`;
  const wrong = SETTING_KEYS.filter((key) => project[key] !== desired.settings[key]).map(
    (key) => `${key} is ${project[key] ?? "unknown"}, not ${desired.settings[key]}`,
  );
  out.push(
    wrong.length
      ? f.fail("settings", `project ${projectId}: ${list(wrong)}`, apply)
      : f.ok(
          "settings",
          `project ${projectId} records sessions, exceptions, console logs and heatmaps as infra/posthog.json says`,
        ),
  );

  const have = new Set(observed.groupTypes.map((g) => g.group_type));
  const missing = desired.groupTypes.filter((name) => !have.has(name));
  if (!missing.length) {
    out.push(
      f.ok(
        "group-types",
        `project ${projectId} has the group type${desired.groupTypes.length === 1 ? "" : "s"} ${list(desired.groupTypes)}`,
      ),
    );
  } else if (!project.ingested_event) {
    out.push(
      f.pending(
        "group-types",
        `project ${projectId} has had no event yet, so the group type${missing.length === 1 ? "" : "s"} ${list(missing)} cannot exist yet`,
        "send a first event from a signed-in app (founder step D15), then check again",
      ),
    );
  } else {
    out.push(
      f.fail(
        "group-types",
        `project ${projectId} has events but no group type ${list(missing)}`,
        "events must carry the workspace group (docs/analytics.md › Groups)",
      ),
    );
  }
  return out;
}

export const posthogSection: Section<PosthogDesired, PosthogObserved> = {
  area: "posthog",
  needs: ["POSTHOG_PERSONAL_API_KEY"],
  desired: posthogDesired,
  fetchObserved: fetchPosthog,
  evaluate: evaluatePosthog,
};
