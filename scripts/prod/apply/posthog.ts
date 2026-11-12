/**
 * `apply.ts posthog`: the four project settings in infra/posthog.json, through PostHog's REST API
 * with a personal API key (`project:write`): `PATCH {apiHost}/api/projects/{id}/`. PostHog has no
 * official SDK for its management API (posthog-node only captures), so this is a plain fetch, as
 * the check's read is.
 *
 * Not proven: that PostHog still takes these four fields on `/api/projects/{id}/` and not only on
 * `/api/environments/{id}/`. The read after `--yes` is what proves it: if PostHog ignored them,
 * the check's settings line stays `fail` and apply exits 1.
 */
import { evaluatePosthog, fetchPosthog, posthogDesired } from "../checks/posthog.ts";
import { type ApplyArea, type ApplyContext, type Plan, pick, send } from "./area.ts";

export async function planPosthog(ctx: ApplyContext): Promise<Plan> {
  const desired = posthogDesired(ctx);
  if (desired.projectId === null) {
    return {
      notes: [
        `infra/environments.json names no PostHog project for ${ctx.env} yet (founder step D8)`,
      ],
      changes: [],
    };
  }
  const observed = await fetchPosthog(ctx, desired);
  if (!observed.project) {
    return {
      notes: [`PostHog has no project ${desired.projectId} that the key can see`],
      changes: [],
    };
  }
  const project = observed.project;
  const wrong = (Object.keys(desired.settings) as (keyof typeof desired.settings)[]).filter(
    (key) => project[key] !== desired.settings[key],
  );
  if (!wrong.length) {
    return {
      notes: [`project ${desired.projectId}'s settings are infra/posthog.json's`],
      changes: [],
    };
  }
  const request = {
    method: "PATCH" as const,
    url: `${desired.apiHost}/api/projects/${desired.projectId}/`,
    body: { ...desired.settings },
  };
  return {
    notes: [],
    changes: [
      {
        says: `project ${desired.projectId}: ${wrong.map((k) => `${k} is ${project[k] ?? "unknown"}, not ${desired.settings[k]}`).join(", ")}`,
        request,
        send: async () => {
          await send(ctx, "PostHog", request, {
            authorization: `Bearer ${ctx.credentials.POSTHOG_PERSONAL_API_KEY}`,
          });
        },
      },
    ],
  };
}

export const posthogArea: ApplyArea = {
  name: "posthog",
  needs: ["POSTHOG_PERSONAL_API_KEY"],
  plan: planPosthog,
  async verify(ctx) {
    const desired = posthogDesired(ctx);
    return pick(evaluatePosthog(desired, await fetchPosthog(ctx, desired)), [
      "posthog.project",
      "posthog.settings",
    ]);
  },
};
