/**
 * `--deep`: make one throwaway sandbox from the current image in the environment's project, then
 * remove it. That proves the image resolves in that project's registry and that a sandbox can be
 * made with the script's token, which nothing read-only can. It is the one part of the check
 * that creates anything, so it runs only when asked, and on production only the founder asks
 * (docs/production.md, "Checking production"). The name is `pz-test-check-<8 random>`, which no
 * sweep matches, and it is removed whether or not the creation worked.
 */

import currentImage from "../../../apps/runner/image/current.json" with { type: "json" };
import {
  type Sandboxes,
  systemClock,
  testSandboxName,
  type VercelCredentials,
  vercelSandboxes,
} from "../../../packages/sandbox/src/index.ts";
import type { EnvironmentName } from "../desired.ts";
import {
  type CheckContext,
  describeError,
  type Finding,
  findings,
  type Section,
} from "./finding.ts";
import { readProjectId } from "./vercel.ts";

/** Long enough to boot, short enough that a sandbox left behind by a crash stops on its own. */
const SESSION_MS = 5 * 60_000;

export interface DeepDesired {
  env: EnvironmentName;
  project: string | null;
  image: string;
}

export interface DeepObserved {
  /** `null`: the project does not exist. */
  projectFound: boolean;
  name: string | null;
  up: { image: string; ms: number } | { error: string } | null;
  removed: true | { error: string } | null;
}

export type MakeSandboxes = (credentials: VercelCredentials, ctx: CheckContext) => Sandboxes;

const realSandboxes: MakeSandboxes = (credentials, ctx) =>
  vercelSandboxes({ clock: systemClock, credentials, fetch: ctx.fetch });

export function deepDesired(ctx: Pick<CheckContext, "env" | "infra">): DeepDesired {
  return {
    env: ctx.env,
    project: ctx.infra["environments.json"].environments[ctx.env].vercelProject,
    image: currentImage.image,
  };
}

export async function fetchDeep(
  ctx: CheckContext,
  desired: DeepDesired,
  make: MakeSandboxes = realSandboxes,
  findProject: (ctx: CheckContext, name: string) => Promise<string | null> = readProjectId,
): Promise<DeepObserved> {
  const projectId = desired.project ? await findProject(ctx, desired.project) : null;
  if (!projectId) return { projectFound: false, name: null, up: null, removed: null };
  const sandboxes = make(
    {
      token: ctx.credentials.VERCEL_TOKEN as string,
      teamId: ctx.credentials.VERCEL_TEAM_ID as string,
      projectId,
    },
    ctx,
  );
  const name = testSandboxName("check");
  const started = ctx.now().getTime();
  let up: DeepObserved["up"];
  try {
    const answer = await sandboxes.up(name, {
      image: desired.image,
      persistent: false,
      timeoutMs: SESSION_MS,
      ports: [],
    });
    up = { image: answer.image, ms: ctx.now().getTime() - started };
  } catch (error) {
    up = { error: describeError(error) };
  }
  let removed: DeepObserved["removed"];
  try {
    await sandboxes.remove(name);
    removed = true;
  } catch (error) {
    removed = { error: describeError(error) };
  }
  return { projectFound: true, name, up, removed };
}

const f = findings("deep");

/** `sha256:…` of `repo@sha256:…`, as Vercel reports a sandbox's image. */
const imageDigest = (image: string) => /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1] ?? null;

export function evaluateDeep(desired: DeepDesired, observed: DeepObserved): Finding[] {
  if (!observed.projectFound) {
    const says = `${desired.project ?? "the project"} does not exist, so no sandbox can be made in it`;
    return [
      desired.env === "production"
        ? f.pending("sandbox", says, "founder step D2")
        : f.fail("sandbox", says),
    ];
  }
  const out: Finding[] = [];
  const up = observed.up;
  if (!up || "error" in up) {
    out.push(
      f.fail(
        "sandbox",
        `a sandbox from ${desired.image} could not be made: ${up ? up.error : "not tried"}`,
      ),
    );
  } else if (!imageDigest(desired.image) || imageDigest(up.image) !== imageDigest(desired.image)) {
    out.push(f.fail("sandbox", `the sandbox booted ${up.image}, not ${desired.image}`));
  } else {
    out.push(
      f.ok(
        "sandbox",
        `a sandbox from ${desired.image} was made in ${Math.round(up.ms / 100) / 10} s`,
      ),
    );
  }
  const removed = observed.removed;
  out.push(
    removed === true
      ? f.ok("cleanup", `${observed.name} was removed`)
      : f.fail(
          "cleanup",
          `${observed.name} was not removed: ${removed ? removed.error : "not tried"}`,
          `remove it in Vercel › ${desired.project} › Sandboxes`,
        ),
  );
  return out;
}

export const deepSection: Section<DeepDesired, DeepObserved> = {
  area: "deep",
  needs: ["VERCEL_TOKEN", "VERCEL_TEAM_ID"],
  deepOnly: true,
  desired: deepDesired,
  fetchObserved: (ctx, desired) => fetchDeep(ctx, desired),
  evaluate: evaluateDeep,
};
