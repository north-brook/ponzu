/**
 * The Vercel areas of the apply script: the project's settings (`vercel-project`), its public
 * environment variables (`vercel-env`), the secrets apply makes itself (`secrets generate`) and
 * the firewall (`firewall`). Reads go through the check's readers (checks/vercel.ts). Writes go
 * through `@vercel/sdk` (createProject, updateProject, createProjectEnv, editProjectEnv), except
 * the firewall's: see `firewallArea`.
 *
 * The SDK checks each answer against its own schema, which lags the API. A write the API has
 * accepted can still come back as a ResponseValidationError; that is a success, and the read
 * after `--yes` is what proves it.
 */
import { ResponseValidationError } from "@vercel/sdk/models/responsevalidationerror.js";
import { SDKValidationError } from "@vercel/sdk/models/sdkvalidationerror.js";
import { VercelError } from "@vercel/sdk/models/vercelerror.js";
import { z } from "zod";
import { findings } from "../checks/finding.ts";
import {
  answer,
  answerOrMissing,
  evaluateFirewall,
  evaluateVercel,
  fetchVercel,
  PROTECTED,
  readProjectId,
  team,
  type VercelDesired,
  vercelClient,
  vercelDesired,
} from "../checks/vercel.ts";
import type { EnvironmentName, Infra } from "../desired.ts";
import {
  type ApplyArea,
  type ApplyContext,
  type Change,
  type Plan,
  pick,
  send,
  statusError,
} from "./area.ts";

export const VERCEL_API = "https://api.vercel.com";

/** The query string the SDK adds for the team: `teamId=…` when given, else the public slug. */
function teamQuery(ctx: Pick<ApplyContext, "credentials">): string {
  const scope = team(ctx);
  return "teamId" in scope ? `teamId=${scope.teamId}` : `slug=${scope.slug}`;
}

/** Runs one SDK write. A refused answer schema is a success; an error says only its status. */
export async function write(what: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ResponseValidationError) return;
    // A 2xx the SDK does not recognise (an answer shape it lacks) was still accepted.
    if (error instanceof VercelError && error.statusCode >= 200 && error.statusCode < 300) return;
    if (error instanceof VercelError) throw statusError("Vercel", error.statusCode, what);
    // The SDK checked the request against its own schema and refused it before sending. Its
    // message quotes the input, which can be a secret, so only this sentence is kept.
    if (error instanceof SDKValidationError) {
      throw new Error(`@vercel/sdk refused the request for ${what} before sending it`);
    }
    throw statusError("Vercel", null, what);
  }
}

// --- vercel-project -----------------------------------------------------------------------------

/** What deployment protection apply sets: Standard Protection (the check accepts it). */
export const STANDARD_PROTECTION = "prod_deployment_urls_and_all_previews";

export async function planProject(ctx: ApplyContext): Promise<Plan> {
  const desired = vercelDesired(ctx);
  const notes: string[] = [];
  if (!desired.project) {
    return { notes: [`infra names no Vercel project for ${ctx.env} yet`], changes: [] };
  }
  const name = desired.project;
  const query = teamQuery(ctx);
  const vercel = vercelClient(ctx);
  const scope = team(ctx);
  const observed = await fetchVercel(ctx, desired);
  const project = observed.project;
  const changes: Change[] = [];

  if (!project) {
    const body = {
      name,
      framework: desired.framework,
      rootDirectory: desired.rootDirectory,
      serverlessFunctionRegion: desired.region,
      oidcTokenConfig: { enabled: true, issuerMode: "team" },
      ssoProtection: { deploymentType: STANDARD_PROTECTION },
    };
    changes.push({
      says: `${name} does not exist: create it with no Git repository and no environment variables`,
      request: { method: "POST", url: `${VERCEL_API}/v11/projects?${query}`, body },
      send: () =>
        write("creating the project", () =>
          vercel.projects.createProject({
            ...scope,
            requestBody: body as Parameters<
              typeof vercel.projects.createProject
            >[0]["requestBody"] &
              object,
          }),
        ),
    });
    // createProject takes no Node version, so the update that follows sets it.
    const update = { nodeVersion: desired.nodeVersion };
    changes.push({
      says: `then set its Node version to ${desired.nodeVersion}`,
      request: { method: "PATCH", url: `${VERCEL_API}/v9/projects/${name}?${query}`, body: update },
      send: () => updateProject(ctx, name, update),
    });
    return { notes, changes };
  }

  const body: Record<string, unknown> = {};
  const why: string[] = [];
  if (project.rootDirectory !== desired.rootDirectory) {
    body.rootDirectory = desired.rootDirectory;
    why.push(`root directory ${project.rootDirectory ?? "unset"} → ${desired.rootDirectory}`);
  }
  if (project.nodeVersion !== desired.nodeVersion) {
    body.nodeVersion = desired.nodeVersion;
    why.push(`Node ${project.nodeVersion ?? "unset"} → ${desired.nodeVersion}`);
  }
  if (project.region !== desired.region) {
    body.serverlessFunctionRegion = desired.region;
    why.push(`function region ${project.region ?? "unset"} → ${desired.region}`);
  }
  if (project.framework !== null && project.framework !== desired.framework) {
    body.framework = desired.framework;
    why.push(`framework ${project.framework} → ${desired.framework}`);
  }
  if (!project.oidc.enabled || project.oidc.issuerMode !== "team") {
    body.oidcTokenConfig = { enabled: true, issuerMode: "team" };
    why.push("OIDC → on, issued by the team");
  }
  if (!project.protection || !PROTECTED.includes(project.protection)) {
    body.ssoProtection = { deploymentType: STANDARD_PROTECTION };
    why.push(`deployment protection ${project.protection ?? "off"} → ${STANDARD_PROTECTION}`);
  }
  if (project.gitConnected) {
    notes.push(
      `${name} has a Git repository connected; apply does not disconnect it. Vercel › ${name} › Settings › Git › Disconnect`,
    );
  }
  if (Object.keys(body).length) {
    changes.push({
      says: `${name}: ${why.join("; ")}`,
      request: { method: "PATCH", url: `${VERCEL_API}/v9/projects/${name}?${query}`, body },
      send: () => updateProject(ctx, name, body),
    });
  } else {
    notes.push(`${name}'s settings already match`);
  }
  return { notes, changes };
}

function updateProject(ctx: ApplyContext, name: string, body: Record<string, unknown>) {
  const vercel = vercelClient(ctx);
  return write("updating the project", () =>
    vercel.projects.updateProject({
      idOrName: name,
      ...team(ctx),
      requestBody: body as Parameters<typeof vercel.projects.updateProject>[0]["requestBody"],
    }),
  );
}

export const vercelProjectArea: ApplyArea = {
  name: "vercel-project",
  needs: ["VERCEL_TOKEN"],
  plan: planProject,
  async verify(ctx) {
    const desired = vercelDesired(ctx);
    const lines = evaluateVercel(desired, await fetchVercel(ctx, desired));
    return pick(lines, ["vercel.project", "vercel.settings", "vercel.oidc", "vercel.protection"]);
  },
};

// --- the project's environment variables -------------------------------------------------------

const RawEnvs = z.object({
  envs: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      type: z.string(),
      target: z.union([z.array(z.string()), z.string()]).nullish(),
      value: z.string().nullish(),
    }),
  ),
});

export interface LiveEnv {
  id: string;
  key: string;
  type: string;
  targets: string[];
  /** Only a `plain` variable's value is kept; every other value is dropped as it is read. */
  value: string | null;
}

/** The project's variables, without decrypting anything: only `plain` values come back. */
export async function readEnv(ctx: ApplyContext, project: string): Promise<LiveEnv[]> {
  const vercel = vercelClient(ctx);
  let raw: unknown;
  try {
    raw = await answer(() =>
      vercel.projects.filterProjectEnvs({ idOrName: project, ...team(ctx) }),
    );
  } catch (error) {
    if (error instanceof VercelError) {
      throw statusError("Vercel", error.statusCode, "the project's variables");
    }
    throw statusError("Vercel", null, "the project's variables");
  }
  return RawEnvs.parse(raw).envs.map((e) => ({
    id: e.id,
    key: e.key,
    type: e.type,
    targets: e.target == null ? [] : [e.target].flat(),
    value: e.type === "plain" ? (e.value ?? null) : null,
  }));
}

/** What a public value is waiting on, when infra has none yet. */
const PUBLIC_PENDING: Record<string, string> = {
  WORKOS_CLIENT_ID: "founder step D7",
  NEON_REALTIME_URL: "founder step D3",
};

/**
 * The public values infra/environments.json gives the API, by name. `null`: infra has none yet.
 * Names infra deliberately leaves out (dev's private bucket and minimum versions) are absent.
 */
export function publicEnv(
  env: EnvironmentName,
  infra: Pick<Infra, "environments.json">,
): Record<string, string | null> {
  const e = infra["environments.json"].environments[env];
  const out: Record<string, string | null> = {
    PONZU_ENVIRONMENT: env,
    PONZU_API_URL: e.apiUrl,
    WORKOS_CLIENT_ID: e.workosClientId,
    GITHUB_APP_SLUG: e.githubAppSlug,
    NEON_REALTIME_URL: e.realtimeUrl,
    PONZU_ASSETS_URL: e.assetsUrl,
    R2_BUCKET: e.r2.assets,
    PONZU_POSTHOG_HOST: e.posthog.host,
    PONZU_POSTHOG_AI_CONTENT: e.posthog.aiContent ? "1" : "0",
  };
  if (e.r2.private !== false) out.R2_PRIVATE_BUCKET = e.r2.private;
  if (e.minClientVersions !== false) out.PONZU_MIN_CLIENT_VERSIONS = e.minClientVersions;
  return out;
}

/** Public values infra does not hold, and where each comes from. */
export const PUBLIC_ELSEWHERE =
  "R2_ACCOUNT_ID and PONZU_POSTHOG_KEY are set by hand (founder steps D4 and D8); GITHUB_APP_CLIENT_ID and GITHUB_APP_BOT_USER_ID by github-app.ts (D6)";

export async function planEnv(ctx: ApplyContext): Promise<Plan> {
  return (await planEnvDetailed(ctx)).plan;
}

/** The plan, and the names whose live value apply could not compare (stored unreadably, or twice). */
async function planEnvDetailed(
  ctx: ApplyContext,
): Promise<{ plan: Plan; unproven: string[]; missing?: string }> {
  const desired = vercelDesired(ctx);
  if (!desired.project) {
    const missing = `infra names no Vercel project for ${ctx.env} yet`;
    return { plan: { notes: [missing], changes: [] }, unproven: [], missing };
  }
  const name = desired.project;
  if ((await readProjectId(ctx, name)) === null) {
    const missing = `${name} does not exist yet: run apply.ts vercel-project --env ${ctx.env} first`;
    return { plan: { notes: [missing], changes: [] }, unproven: [], missing };
  }
  const vercel = vercelClient(ctx);
  const query = teamQuery(ctx);
  const live = (await readEnv(ctx, name)).filter((e) => e.targets.includes("production"));
  const notes: string[] = [];
  const changes: Change[] = [];
  const unproven: string[] = [];
  const create: { key: string; value: string; type: "plain"; target: ["production"] }[] = [];

  for (const [key, value] of Object.entries(publicEnv(ctx.env, ctx.infra))) {
    if (value === null) {
      notes.push(
        `${key}: infra has no value yet (${PUBLIC_PENDING[key] ?? "not created yet"}); left alone`,
      );
      continue;
    }
    const entries = live.filter((e) => e.key === key);
    const entry = entries[0];
    if (!entry) {
      create.push({ key, value, type: "plain", target: ["production"] });
    } else if (entries.length > 1) {
      unproven.push(key);
      notes.push(
        `${key} is set ${entries.length} times on the Production target; remove all but one`,
      );
    } else if (entry.type !== "plain") {
      unproven.push(key);
      notes.push(
        `${key} is stored as ${entry.type}, so its value cannot be read back to compare; left alone (to make it ${JSON.stringify(value)}, remove it in Vercel and run again)`,
      );
    } else if (entry.value === value) {
      notes.push(`${key} is ${JSON.stringify(value)}`);
    } else {
      const body = { value };
      changes.push({
        says: `${key} is ${JSON.stringify(entry.value)}, not ${JSON.stringify(value)}`,
        request: {
          method: "PATCH",
          url: `${VERCEL_API}/v9/projects/${name}/env/${entry.id}?${query}`,
          body,
        },
        send: () =>
          write(`changing ${key}`, () =>
            vercel.projects.editProjectEnv({
              idOrName: name,
              id: entry.id,
              ...team(ctx),
              requestBody: body,
            }),
          ),
      });
    }
  }
  if (create.length) {
    changes.unshift({
      says: `the Production target lacks ${create.map((c) => c.key).join(", ")}: add them as plain (public) values`,
      request: {
        method: "POST",
        url: `${VERCEL_API}/v10/projects/${name}/env?${query}`,
        body: create,
      },
      send: () =>
        write("adding the public values", () =>
          vercel.projects.createProjectEnv({ idOrName: name, ...team(ctx), requestBody: create }),
        ),
    });
  }
  notes.push(PUBLIC_ELSEWHERE);
  return { plan: { notes, changes }, unproven };
}

export const vercelEnvArea: ApplyArea = {
  name: "vercel-env",
  needs: ["VERCEL_TOKEN"],
  plan: planEnv,
  async verify(ctx) {
    const f = findings("vercel");
    const { plan: left, unproven, missing } = await planEnvDetailed(ctx);
    // No project means nothing was stored: never a pass. Production's project is founder step D2.
    if (missing) {
      return [
        ctx.env === "production"
          ? f.pending("env.public", `${missing} (founder step D2)`)
          : f.fail("env.public", missing),
      ];
    }
    if (left.changes.length) {
      return [f.fail("env.public", `still to do: ${left.changes.map((c) => c.says).join("; ")}`)];
    }
    // A value apply could not read back is not proven right, so it is not a pass.
    if (unproven.length) {
      return [
        f.manual(
          "env.public",
          `${unproven.join(", ")} could not be compared (stored unreadably, or set more than once); a person confirms ${unproven.length === 1 ? "it" : "them"}`,
        ),
      ];
    }
    return [f.ok("env.public", "every public value infra holds is set on the Production target")];
  },
};

// --- secrets generate ---------------------------------------------------------------------------

/**
 * The only secrets apply makes itself: each is 32 random bytes and nothing else knows it. Every
 * other secret comes from the vendor that issues it (docs/production.md › Env and secrets).
 */
export const GENERATED_SECRETS = ["PONZU_VAULT_KEY", "CRON_SECRET"] as const;
export const SECRET_BYTES = 32;
/** What the dry run shows in place of a value that does not exist until `--yes`. */
export const NOT_YET_GENERATED = `<${SECRET_BYTES} random bytes in base64url, made only when sent, never shown>`;

/** 32 random bytes as base64url: what PONZU_VAULT_KEY needs (vault.ts) and CRON_SECRET accepts. */
export function generateSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(SECRET_BYTES))).toString("base64url");
}

export const SECRETS_USAGE = `apply.ts secrets generate --names ${GENERATED_SECRETS.join(",")} --env <env> [--yes]`;

/** The names `generate --names A,B` asks for; throws on anything else. */
export function secretNames(args: readonly string[]): string[] {
  const at = args.indexOf("--names");
  const names = at === -1 ? undefined : args[at + 1];
  const rest = args.filter((_, i) => i !== at && i !== at + 1);
  if (rest.join(" ") !== "generate" || !names) throw new Error(`usage: ${SECRETS_USAGE}`);
  const list = names.split(",").map((n) => n.trim());
  const unknown = list.filter((n) => !(GENERATED_SECRETS as readonly string[]).includes(n));
  if (unknown.length) {
    throw new Error(
      `apply makes only ${GENERATED_SECRETS.join(" and ")}; ${unknown.join(", ")} come${unknown.length === 1 ? "s" : ""} from the vendor that issues ${unknown.length === 1 ? "it" : "them"}`,
    );
  }
  return [...new Set(list)];
}

export async function planSecrets(ctx: ApplyContext): Promise<Plan> {
  const names = secretNames(ctx.args);
  const desired = vercelDesired(ctx);
  if (!desired.project) {
    return { notes: [`infra names no Vercel project for ${ctx.env} yet`], changes: [] };
  }
  const name = desired.project;
  if ((await readProjectId(ctx, name)) === null) {
    return {
      notes: [`${name} does not exist yet: run apply.ts vercel-project --env ${ctx.env} first`],
      changes: [],
    };
  }
  const vercel = vercelClient(ctx);
  const query = teamQuery(ctx);
  const live = await readEnv(ctx, name);
  const notes: string[] = [];
  const changes: Change[] = [];
  for (const key of names) {
    if (live.some((e) => e.key === key && e.targets.includes("production"))) {
      // Replacing PONZU_VAULT_KEY would leave every sealed secret unreadable; rotation keeps the
      // old key in PONZU_VAULT_OLD_KEYS. So an existing secret is never overwritten here.
      notes.push(
        `${key} is already set on ${name}'s Production target; apply never replaces it (docs/production.md › Rotating secrets)`,
      );
      continue;
    }
    const shown = [{ key, value: NOT_YET_GENERATED, type: "sensitive", target: ["production"] }];
    changes.push({
      says: `${key} is not set: make ${SECRET_BYTES} random bytes and store them as sensitive on the Production target`,
      request: {
        method: "POST",
        url: `${VERCEL_API}/v10/projects/${name}/env?${query}`,
        body: shown,
      },
      async send() {
        // Made here, held only in this call, handed to the redactor before anything else, and
        // sent once. It is never printed, logged or written anywhere but Vercel.
        const value = generateSecret();
        ctx.secret(value);
        await write(`storing ${key}`, () =>
          vercel.projects.createProjectEnv({
            idOrName: name,
            ...team(ctx),
            requestBody: [{ key, value, type: "sensitive", target: ["production"] }],
          }),
        );
      },
    });
  }
  return { notes, changes };
}

export const secretsArea: ApplyArea = {
  name: "secrets",
  needs: ["VERCEL_TOKEN"],
  usage: SECRETS_USAGE,
  plan: planSecrets,
  async verify(ctx) {
    const f = findings("vercel");
    const project = vercelDesired(ctx).project as string;
    const live = await readEnv(ctx, project);
    return secretNames(ctx.args).map((key) => {
      const entry = live.find((e) => e.key === key && e.targets.includes("production"));
      return entry?.type === "sensitive"
        ? f.ok(`secrets.${key}`, `${key} is on the Production target, stored as sensitive`)
        : f.fail(
            `secrets.${key}`,
            entry ? `${key} is stored as ${entry.type}, not sensitive` : `${key} is not set`,
          );
    });
  },
};

// --- firewall -----------------------------------------------------------------------------------

/**
 * `PUT /v1/security/firewall/config` with infra/vercel-firewall.json as it is, sent with a plain
 * fetch rather than `security.putFirewallConfig`: on @vercel/sdk 1.28.53 that method's request
 * schema declares `managedRules` as an empty object and strips `bot_protection` and `ai_bots`
 * before sending (a test pins this), so the SDK cannot apply the file. URL, query and body are
 * the ones the SDK would send.
 */
const RawIps = z.object({
  ips: z
    .array(
      z.object({
        id: z.string().optional(),
        hostname: z.string(),
        ip: z.string(),
        notes: z.string().nullish(),
        action: z.string(),
      }),
    )
    .nullish(),
});

/** The live firewall's IP blocks, in the shape a PUT takes them. */
async function readFirewallIps(ctx: ApplyContext, projectId: string) {
  const vercel = vercelClient(ctx);
  let raw: unknown;
  try {
    raw = await answerOrMissing(() =>
      vercel.security.getFirewallConfig({ projectId, configVersion: "active", ...team(ctx) }),
    );
  } catch (error) {
    if (error instanceof VercelError) {
      throw statusError("Vercel", error.statusCode, "the firewall's IP blocks");
    }
    throw statusError("Vercel", null, "the firewall's IP blocks");
  }
  return (RawIps.parse(raw ?? {}).ips ?? []).map(({ id, hostname, ip, notes, action }) => ({
    ...(id ? { id } : {}),
    hostname,
    ip,
    ...(notes ? { notes } : {}),
    action,
  }));
}

export async function planFirewall(ctx: ApplyContext): Promise<Plan> {
  const desired: VercelDesired = vercelDesired(ctx);
  if (!desired.project) {
    return { notes: [`infra names no Vercel project for ${ctx.env} yet`], changes: [] };
  }
  const projectId = await readProjectId(ctx, desired.project);
  if (!projectId) {
    return {
      notes: [
        `${desired.project} does not exist yet: run apply.ts vercel-project --env ${ctx.env} first`,
      ],
      changes: [],
    };
  }
  const observed = await fetchVercel(ctx, desired);
  const lines = evaluateFirewall(desired, observed.firewall);
  const wrong = lines.filter((l) => l.status !== "ok");
  if (!wrong.length) {
    return {
      notes: [`the live firewall of ${desired.project} is infra/vercel-firewall.json's`],
      changes: [],
    };
  }
  // A PUT replaces the whole configuration. infra/ says nothing about IP blocks, which a person
  // adds in the dashboard (during an attack, say), so the live ones are sent back as they are.
  const ips = await readFirewallIps(ctx, projectId);
  const request = {
    method: "PUT" as const,
    url: `${VERCEL_API}/v1/security/firewall/config?projectId=${projectId}&${teamQuery(ctx)}`,
    body: ips.length ? { ...desired.firewall, ips } : desired.firewall,
  };
  const kept = ips.length
    ? [
        `${ips.length} IP block${ips.length === 1 ? "" : "s"} set in the dashboard ${ips.length === 1 ? "is" : "are"} sent back unchanged`,
      ]
    : [];
  return {
    notes: [...lines.filter((l) => l.status === "ok").map((l) => `${l.id}: ${l.says}`), ...kept],
    changes: [
      {
        says: `${desired.project}'s firewall: ${wrong.map((l) => l.says).join("; ")}. Replace it with infra/vercel-firewall.json`,
        request,
        send: async () => {
          await send(ctx, "Vercel", request, {
            authorization: `Bearer ${ctx.credentials.VERCEL_TOKEN}`,
          });
        },
      },
    ],
  };
}

export const firewallArea: ApplyArea = {
  name: "firewall",
  needs: ["VERCEL_TOKEN"],
  plan: planFirewall,
  async verify(ctx) {
    const desired = vercelDesired(ctx);
    return evaluateFirewall(desired, (await fetchVercel(ctx, desired)).firewall);
  },
};
