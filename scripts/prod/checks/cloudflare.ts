/**
 * Cloudflare: the environment's R2 buckets (where they are, how they are served, their CORS and
 * lifecycle), the API's R2 token's reach, and the response header rule on the assets host in the
 * `ponzu.cloud` zone. Read through the official `cloudflare` SDK with a read-only token, every
 * call a GET:
 *
 * - `r2.buckets.get`, `.domains.custom.list`, `.domains.managed.list`, `.cors.get`,
 *   `.lifecycle.get` for each bucket;
 * - `zones.list({ name })` and `rulesets.phases.get("http_response_headers_transform")`;
 * - `accounts.tokens.list`: the account's API tokens, of which only status and policies are kept.
 *   R2's S3 access key id is its token's id, so ids are dropped as soon as they are read.
 *
 * The read-only token needs, on the account: Workers R2 Storage Read and Account API Tokens Read;
 * on the zone ponzu.cloud: Zone Read and Transform Rules Read (docs/production.md, D4).
 *
 * No lifecycle rule may delete anything under `private/` (program §5.15): a rule cannot tell a
 * recorded checkpoint from an unrecorded one. That holds for whatever is live, whatever infra says.
 */
import Cloudflare from "cloudflare";
import { z } from "zod";
import type { EnvironmentName, Infra } from "../desired.ts";
import { type CheckContext, type Finding, findings, list, type Section } from "./finding.ts";

/** Where production's buckets are placed (location hint), per the design. Dev's is not judged. */
export const PRODUCTION_LOCATION = "enam";
/** What the API's presigned uploads and the apps need at the least, whatever CORS infra adds. */
export const CORS_AT_LEAST = {
  origins: ["ponzu-studio://app", "https://ponzu.design"],
  methods: ["GET", "HEAD", "PUT"],
  headers: ["content-type", "x-amz-checksum-sha256", "cache-control", "content-disposition"],
} as const;
const PHASE = "http_response_headers_transform";
const MAX_TOKENS = 1000;

// --- desired ------------------------------------------------------------------------------------

export interface CloudflareDesired {
  env: EnvironmentName;
  /** `null`: not named in infra yet. */
  assets: string | null;
  /** `false`: no private bucket on purpose; `null`: not named yet. */
  private: string | false | null;
  /** The custom domain the assets bucket is served at (environments.json's assetsUrl). */
  assetsHost: string | null;
  location: string | null;
  cors: Infra["r2/cors.json"];
  lifecycle: Infra["r2/lifecycle.json"];
  headers: {
    zone: string;
    host: string;
    required: boolean;
    values: Record<string, string>;
  };
}

export function cloudflareDesired(ctx: Pick<CheckContext, "env" | "infra">): CloudflareDesired {
  const environment = ctx.infra["environments.json"].environments[ctx.env];
  const rule = ctx.infra["cloudflare/assets-headers.json"];
  return {
    env: ctx.env,
    assets: environment.r2.assets,
    private: environment.r2.private,
    assetsHost: environment.assetsUrl ? new URL(environment.assetsUrl).hostname : null,
    location: ctx.env === "production" ? PRODUCTION_LOCATION : null,
    cors: ctx.infra["r2/cors.json"],
    lifecycle: ctx.infra["r2/lifecycle.json"],
    headers: {
      zone: rule.zone,
      host: rule.hosts[ctx.env].host,
      required: rule.hosts[ctx.env].required,
      values: rule.headers,
    },
  };
}

// --- observed -----------------------------------------------------------------------------------

const AgeOrDate = z.object({
  type: z.string(),
  maxAge: z.number().nullish(),
  date: z.string().nullish(),
});

const RawLifecycle = z.object({
  rules: z
    .array(
      z.object({
        enabled: z.boolean(),
        conditions: z.object({ prefix: z.string().default("") }).default({ prefix: "" }),
        deleteObjectsTransition: z.object({ condition: AgeOrDate.nullish() }).nullish(),
        abortMultipartUploadsTransition: z.object({ condition: AgeOrDate.nullish() }).nullish(),
        storageClassTransitions: z.array(z.unknown()).nullish(),
      }),
    )
    .nullish(),
});

const RawCors = z.object({
  rules: z
    .array(
      z.object({
        allowed: z.object({
          origins: z.array(z.string()),
          methods: z.array(z.string()),
          headers: z.array(z.string()).nullish(),
        }),
        exposeHeaders: z.array(z.string()).nullish(),
        maxAgeSeconds: z.number().nullish(),
      }),
    )
    .nullish(),
});

const RawBucket = z.object({
  /** `null`: the bucket does not exist. */
  bucket: z.object({ name: z.string().nullish(), location: z.string().nullish() }).nullable(),
  custom: z
    .object({
      domains: z.array(
        z.object({
          domain: z.string(),
          enabled: z.boolean(),
          status: z.object({ ownership: z.string(), ssl: z.string() }).nullish(),
        }),
      ),
    })
    .nullish(),
  managed: z.object({ domain: z.string().nullish(), enabled: z.boolean() }).nullish(),
  /** `null`: no CORS configuration at all (Cloudflare answers 404). */
  cors: RawCors.nullish(),
  lifecycle: RawLifecycle.nullish(),
});

const RawRule = z.object({
  action: z.string().nullish(),
  expression: z.string().nullish(),
  enabled: z.boolean().nullish(),
  description: z.string().nullish(),
  action_parameters: z
    .object({
      headers: z
        .record(
          z.string(),
          z.object({ operation: z.string(), value: z.string().nullish() }).passthrough(),
        )
        .nullish(),
    })
    .passthrough()
    .nullish(),
});

const RawToken = z.object({
  status: z.string().nullish(),
  policies: z
    .array(
      z.object({
        effect: z.string(),
        permission_groups: z.array(z.object({ name: z.string().nullish() })),
        resources: z.record(z.string(), z.unknown()),
      }),
    )
    .nullish(),
});

/**
 * What the check keeps of Cloudflare's answers, in the SDK's own shapes, ids dropped. The
 * fixtures in fixtures/cloudflare/ are this shape, and `fetchCloudflare` builds it.
 */
export const CloudflareAnswers = z.object({
  buckets: z.record(z.string(), RawBucket),
  /** `null`: no zone by that name is visible to the token. */
  zone: z.object({ rules: z.array(RawRule) }).nullable(),
  /** The account's API tokens, or the status Cloudflare refused the listing with. */
  tokens: z.union([z.array(RawToken), z.object({ refused: z.number() })]),
});
export type CloudflareAnswers = z.infer<typeof CloudflareAnswers>;

export interface LifecycleRule {
  enabled: boolean;
  prefix: string;
  /** Seconds after which objects under the prefix are deleted, or a date; `null`: never. */
  deleteAfter: number | string | null;
  abortUploadsAfter: number | null;
  storageClassTransitions: number;
}

export interface BucketObserved {
  exists: boolean;
  location: string | null;
  custom: { domain: string; enabled: boolean; ownership: string | null; ssl: string | null }[];
  /** r2.dev: `null` when Cloudflare would not say. */
  managed: { enabled: boolean } | null;
  cors: CorsRule[] | null;
  lifecycle: LifecycleRule[] | null;
}

export interface CorsRule {
  origins: string[];
  methods: string[];
  headers: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number | null;
}

export interface TokenObserved {
  active: boolean;
  /** Bucket names the token's R2 object permissions name, by resource. */
  buckets: string[];
  /** It holds an R2 permission on the whole account, so it reaches every bucket. */
  accountWide: boolean;
}

export interface CloudflareObserved {
  buckets: Record<string, BucketObserved>;
  zone: null | { rules: z.infer<typeof RawRule>[] };
  tokens: TokenObserved[] | { refused: number };
}

const sorted = (values: readonly string[]) => [...new Set(values)].sort();

export function normalizeCors(raw: z.infer<typeof RawCors>): CorsRule[] {
  return (raw.rules ?? [])
    .map((rule) => ({
      origins: sorted(rule.allowed.origins),
      methods: sorted(rule.allowed.methods.map((m) => m.toUpperCase())),
      headers: sorted((rule.allowed.headers ?? []).map((h) => h.toLowerCase())),
      exposeHeaders: sorted((rule.exposeHeaders ?? []).map((h) => h.toLowerCase())),
      maxAgeSeconds: rule.maxAgeSeconds ?? null,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function normalizeLifecycle(raw: z.infer<typeof RawLifecycle>): LifecycleRule[] {
  return (raw.rules ?? [])
    .map((rule) => {
      const del = rule.deleteObjectsTransition?.condition;
      return {
        enabled: rule.enabled,
        prefix: rule.conditions.prefix,
        deleteAfter: del ? (del.maxAge ?? del.date ?? null) : null,
        abortUploadsAfter: rule.abortMultipartUploadsTransition?.condition?.maxAge ?? null,
        storageClassTransitions: rule.storageClassTransitions?.length ?? 0,
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** R2 permission groups that read or write objects ("Workers R2 Storage Bucket Item Write"). */
const isR2 = (name: string | null | undefined) => !!name && /^Workers R2 Storage/i.test(name);
const BUCKET_RESOURCE = /^com\.cloudflare\.edge\.r2\.bucket\.[^_]+_[^_]+_(.+)$/;
const ACCOUNT_RESOURCE = /^com\.cloudflare\.api\.account\.[^.]+$/;

/** A token as the check judges it: whether it is active, and which buckets it reaches. */
export function observeToken(raw: z.infer<typeof RawToken>): TokenObserved | null {
  const buckets: string[] = [];
  let accountWide = false;
  let r2 = false;
  for (const policy of raw.policies ?? []) {
    if (policy.effect !== "allow") continue;
    if (!policy.permission_groups.some((g) => isR2(g.name))) continue;
    r2 = true;
    for (const key of Object.keys(policy.resources)) {
      const bucket = BUCKET_RESOURCE.exec(key)?.[1];
      if (bucket) buckets.push(bucket);
      else if (ACCOUNT_RESOURCE.test(key)) accountWide = true;
    }
  }
  return r2 ? { active: raw.status === "active", buckets: sorted(buckets), accountWide } : null;
}

/** Pure: Cloudflare's answers (live or recorded) as the check compares them. */
export function observeCloudflare(raw: unknown): CloudflareObserved {
  const answers = CloudflareAnswers.parse(raw);
  const buckets: Record<string, BucketObserved> = {};
  for (const [name, b] of Object.entries(answers.buckets)) {
    buckets[name] = {
      exists: b.bucket !== null,
      location: b.bucket?.location?.toLowerCase() ?? null,
      custom: (b.custom?.domains ?? []).map((d) => ({
        domain: d.domain,
        enabled: d.enabled,
        ownership: d.status?.ownership ?? null,
        ssl: d.status?.ssl ?? null,
      })),
      managed: b.managed ? { enabled: b.managed.enabled } : null,
      cors: b.cors ? normalizeCors(b.cors) : null,
      lifecycle: b.lifecycle ? normalizeLifecycle(b.lifecycle) : null,
    };
  }
  return {
    buckets,
    zone: answers.zone,
    tokens: Array.isArray(answers.tokens)
      ? answers.tokens.map(observeToken).filter((t): t is TokenObserved => t !== null)
      : answers.tokens,
  };
}

/** The SDK over `ctx.fetch`, read-only by use: every call below is a GET. */
export function cloudflareClient(ctx: Pick<CheckContext, "credentials" | "fetch">): Cloudflare {
  return new Cloudflare({
    apiToken: ctx.credentials.CLOUDFLARE_API_TOKEN as string,
    fetch: (input, init) => ctx.fetch(input as RequestInfo, init as RequestInit),
    maxRetries: 1,
  });
}

/** A Cloudflare error as one plain line: its status, never its body or the request. */
export function plainCloudflareError(error: unknown): Error {
  if (error instanceof Cloudflare.APIError) {
    return new Error(
      error.status ? `Cloudflare answered ${error.status}` : "Cloudflare could not be reached",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** The answer, or `null` for a 404: the thing does not exist. */
async function orMissing<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Cloudflare.NotFoundError) return null;
    throw error;
  }
}

/** The buckets the environment names, in the order they are judged. */
export function bucketNames(desired: CloudflareDesired): string[] {
  return [desired.assets, desired.private].filter((b): b is string => typeof b === "string");
}

export async function fetchCloudflare(
  ctx: CheckContext,
  desired: CloudflareDesired,
): Promise<CloudflareObserved> {
  const cf = cloudflareClient(ctx);
  const account_id = ctx.credentials.CLOUDFLARE_ACCOUNT_ID as string;
  try {
    const buckets: CloudflareAnswers["buckets"] = {};
    await Promise.all(
      bucketNames(desired).map(async (name) => {
        const bucket = await orMissing(() => cf.r2.buckets.get(name, { account_id }));
        if (!bucket) {
          buckets[name] = { bucket: null };
          return;
        }
        const [custom, managed, cors, lifecycle] = await Promise.all([
          cf.r2.buckets.domains.custom.list(name, { account_id }),
          cf.r2.buckets.domains.managed.list(name, { account_id }),
          orMissing(() => cf.r2.buckets.cors.get(name, { account_id })),
          orMissing(() => cf.r2.buckets.lifecycle.get(name, { account_id })),
        ]);
        buckets[name] = {
          bucket: { name: bucket.name ?? name, location: bucket.location ?? null },
          custom,
          managed,
          cors: cors ?? null,
          lifecycle: lifecycle ?? { rules: [] },
        };
      }),
    );

    let zone: CloudflareAnswers["zone"] = null;
    const zones = await cf.zones.list({ name: desired.headers.zone });
    const zoneId = zones.result.find((z) => z.name === desired.headers.zone)?.id;
    if (zoneId) {
      const phase = await orMissing(() => cf.rulesets.phases.get(PHASE, { zone_id: zoneId }));
      zone = { rules: (phase?.rules ?? []) as z.infer<typeof RawRule>[] };
    }

    let tokens: CloudflareAnswers["tokens"];
    try {
      const all: z.infer<typeof RawToken>[] = [];
      // The SDK pages until a page comes back empty; a bound keeps a misbehaving answer finite.
      for await (const token of cf.accounts.tokens.list({ account_id, per_page: 50 })) {
        all.push({ status: token.status ?? null, policies: token.policies ?? [] });
        if (all.length >= MAX_TOKENS)
          throw new Error(`the account lists more than ${MAX_TOKENS} API tokens`);
      }
      tokens = all;
    } catch (error) {
      if (error instanceof Cloudflare.APIError && (error.status === 403 || error.status === 401)) {
        tokens = { refused: error.status };
      } else {
        throw error;
      }
    }
    return observeCloudflare({ buckets, zone, tokens });
  } catch (error) {
    throw plainCloudflareError(error);
  }
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("cloudflare");

const APPLY_R2 = (env: EnvironmentName) =>
  `bun scripts/prod/apply.ts r2 --env ${env}${env === "production" ? " --yes (founder step D4)" : ""}`;
const APPLY_HEADERS = (env: EnvironmentName) =>
  `bun scripts/prod/apply.ts cloudflare-headers --env ${env}${env === "production" ? " --yes (founder step D4)" : ""}`;
/** Who sets a bucket up, by environment. */
const SETUP = (env: EnvironmentName) =>
  env === "production" ? "founder step D4" : "founder step B6";

export function evaluateCloudflare(
  desired: CloudflareDesired,
  observed: CloudflareObserved,
): Finding[] {
  const { env } = desired;
  const out: Finding[] = [];

  out.push(...evaluateCorsFile(desired));

  if (!desired.assets) {
    out.push(f.pending("r2.assets", `infra names no assets bucket for ${env} yet`));
  } else {
    out.push(...evaluateAssetsBucket(desired, desired.assets, observed.buckets[desired.assets]));
  }

  if (desired.private === null) {
    out.push(f.pending("r2.private", `infra names no private bucket for ${env} yet`));
  } else if (desired.private === false) {
    out.push(
      f.ok(
        "r2.private",
        `${env} has no private bucket on purpose: checkpoints sit under private/ in the assets bucket`,
      ),
    );
  } else {
    out.push(...evaluatePrivateBucket(desired, desired.private, observed.buckets[desired.private]));
  }

  out.push(evaluateToken(desired, observed.tokens));
  out.push(evaluateHeaders(desired, observed.zone));
  return out;
}

/** infra/r2/cors.json itself must allow what the apps need, so applying it never breaks uploads. */
function evaluateCorsFile(desired: CloudflareDesired): Finding[] {
  const rules = normalizeCors({ rules: desired.cors.rules });
  const short = corsShortfall(rules);
  return short.length
    ? [
        f.fail(
          "r2.cors.file",
          `infra/r2/cors.json does not allow ${list(short)}, which uploads need`,
          "fix infra/r2/cors.json",
        ),
      ]
    : [];
}

/** What a CORS configuration fails to allow, of CORS_AT_LEAST. */
export function corsShortfall(rules: readonly CorsRule[]): string[] {
  const missing: string[] = [];
  for (const origin of CORS_AT_LEAST.origins) {
    const covering = rules.filter((r) => r.origins.includes("*") || r.origins.includes(origin));
    const allows = (method: string) => covering.some((r) => r.methods.includes(method));
    const hasHeader = (header: string) =>
      covering.some(
        (r) => r.methods.includes("PUT") && (r.headers.includes("*") || r.headers.includes(header)),
      );
    const methods = CORS_AT_LEAST.methods.filter((m) => !allows(m));
    const headers = CORS_AT_LEAST.headers.filter((h) => !hasHeader(h));
    if (methods.length) missing.push(`${list(methods)} from ${origin}`);
    if (headers.length)
      missing.push(
        `the header${headers.length === 1 ? "" : "s"} ${list(headers)} on a PUT from ${origin}`,
      );
  }
  return missing;
}

/** A live rule that would delete under private/, where checkpoints live (program §5.15). */
function deletesCheckpoints(rule: LifecycleRule, wholeBucket: boolean): boolean {
  if (!rule.enabled || rule.deleteAfter === null) return false;
  return wholeBucket || rule.prefix.startsWith("private") || "private/".startsWith(rule.prefix);
}

function evaluateAssetsBucket(
  desired: CloudflareDesired,
  name: string,
  bucket: BucketObserved | undefined,
): Finding[] {
  const { env } = desired;
  if (!bucket?.exists) {
    const says = `the bucket ${name} does not exist`;
    return [
      env === "production"
        ? f.pending("r2.assets", `${says} yet`, `Cloudflare › R2: create it (${SETUP(env)})`)
        : f.fail("r2.assets", says, "Cloudflare › R2 (docs/production.md › Cloudflare R2)"),
    ];
  }
  const out: Finding[] = [];
  out.push(bucketLine("r2.assets", desired, name, bucket));

  // Served at its custom domain, and nowhere else.
  const host = desired.assetsHost;
  const domain = host ? bucket.custom.find((d) => d.domain === host) : undefined;
  const served = domain?.enabled && domain.ownership === "active" && domain.ssl === "active";
  const others = bucket.custom.filter((d) => d.domain !== host && d.enabled).map((d) => d.domain);
  const domainFix = `Cloudflare › R2 › ${name} › Settings › Custom Domains (${SETUP(env)})`;
  if (!host) {
    out.push(f.pending("r2.assets.domain", `infra names no assetsUrl for ${env} yet`));
  } else if (!domain) {
    out.push(
      env === "production"
        ? f.pending("r2.assets.domain", `${host} is not attached to ${name} yet`, domainFix)
        : f.fail("r2.assets.domain", `${host} is not attached to ${name}`, domainFix),
    );
  } else if (!served) {
    out.push(
      f.fail(
        "r2.assets.domain",
        `${host} on ${name} is ${domain.enabled ? "enabled" : "disabled"}, ownership ${domain.ownership ?? "unknown"}, certificate ${domain.ssl ?? "unknown"}`,
        domainFix,
      ),
    );
  } else if (others.length) {
    out.push(f.fail("r2.assets.domain", `${name} is also served at ${list(others)}`, domainFix));
  } else {
    out.push(f.ok("r2.assets.domain", `${name} is served at ${host}, active with its certificate`));
  }
  out.push(managedLine("r2.assets.r2dev", name, bucket, env));

  // CORS: exactly the file's.
  const want = normalizeCors({ rules: desired.cors.rules });
  const have = bucket.cors;
  out.push(
    have && JSON.stringify(have) === JSON.stringify(want)
      ? f.ok("r2.assets.cors", `${name}'s CORS is infra/r2/cors.json's`)
      : f.fail(
          "r2.assets.cors",
          !have || !have.length
            ? `${name} has no CORS rules, so the apps cannot upload to it`
            : `${name}'s CORS differs from infra/r2/cors.json${corsShortfall(have).length ? `, and does not allow ${list(corsShortfall(have))}` : ""}`,
          APPLY_R2(env),
        ),
  );

  // Lifecycle: never under private/, and the file's rules.
  const live = bucket.lifecycle ?? [];
  const dangerous = live.filter((r) => deletesCheckpoints(r, false));
  if (dangerous.length) {
    out.push(
      f.fail(
        "r2.assets.lifecycle",
        `${name} has a lifecycle rule deleting under ${list(dangerous.map((r) => `"${r.prefix}"`))}, which would delete live checkpoints under private/`,
        `remove it now: Cloudflare › R2 › ${name} › Settings › Object lifecycle rules; then ${APPLY_R2(env)}`,
      ),
    );
  } else {
    const wanted = normalizeLifecycle({ rules: desired.lifecycle.rules });
    const key = (r: LifecycleRule) => JSON.stringify(r);
    const liveKeys = new Set(live.map(key));
    const missing = wanted.filter((r) => !liveKeys.has(key(r)));
    const extra = live.filter((r) => !wanted.some((w) => key(w) === key(r)));
    const describe = (r: LifecycleRule) =>
      `"${r.prefix}" ${r.deleteAfter !== null ? `deletes after ${age(r.deleteAfter)}` : r.abortUploadsAfter !== null ? `aborts uploads after ${age(r.abortUploadsAfter)}` : "does nothing"}${r.enabled ? "" : " (disabled)"}`;
    if (!missing.length && !extra.length) {
      out.push(f.ok("r2.assets.lifecycle", `${name}'s lifecycle is ${list(wanted.map(describe))}`));
    } else if (missing.length === wanted.length) {
      // Nothing of the file is live: the step that applies it is still to come.
      out.push(
        f.pending(
          "r2.assets.lifecycle",
          `${name} has none of infra/r2/lifecycle.json's rules${live.length ? ` (it has ${list(live.map(describe))})` : ""}`,
          APPLY_R2(env),
        ),
      );
    } else {
      out.push(
        f.fail(
          "r2.assets.lifecycle",
          `${name}'s lifecycle differs: ${[
            missing.length ? `missing ${list(missing.map(describe))}` : "",
            extra.length ? `not in the file ${list(extra.map(describe))}` : "",
          ]
            .filter(Boolean)
            .join("; ")}`,
          APPLY_R2(env),
        ),
      );
    }
  }
  return out;
}

function evaluatePrivateBucket(
  desired: CloudflareDesired,
  name: string,
  bucket: BucketObserved | undefined,
): Finding[] {
  const { env } = desired;
  if (!bucket?.exists) {
    const says = `the bucket ${name} does not exist`;
    return [
      env === "production"
        ? f.pending("r2.private", `${says} yet`, `Cloudflare › R2: create it (${SETUP(env)})`)
        : f.fail("r2.private", says, "Cloudflare › R2 (docs/production.md › Cloudflare R2)"),
    ];
  }
  const out: Finding[] = [bucketLine("r2.private", desired, name, bucket)];
  const served = bucket.custom.filter((d) => d.enabled).map((d) => d.domain);
  out.push(
    served.length
      ? f.fail(
          "r2.private.domain",
          `${name} holds checkpoints but is served at ${list(served)}`,
          `Cloudflare › R2 › ${name} › Settings › Custom Domains: remove it`,
        )
      : f.ok("r2.private.domain", `${name} has no custom domain`),
  );
  out.push(managedLine("r2.private.r2dev", name, bucket, env));
  const dangerous = (bucket.lifecycle ?? []).filter((r) => deletesCheckpoints(r, true));
  out.push(
    dangerous.length
      ? f.fail(
          "r2.private.lifecycle",
          `${name} has a lifecycle rule that deletes objects, which would delete live checkpoints`,
          `remove it: Cloudflare › R2 › ${name} › Settings › Object lifecycle rules`,
        )
      : f.ok("r2.private.lifecycle", `no lifecycle rule deletes anything in ${name}`),
  );
  return out;
}

function bucketLine(
  id: string,
  desired: CloudflareDesired,
  name: string,
  bucket: BucketObserved,
): Finding {
  if (desired.location && bucket.location !== desired.location) {
    return f.fail(
      id,
      `the bucket ${name} is placed in ${bucket.location ?? "an unknown location"}, not ${desired.location.toUpperCase()}`,
      "a bucket's location cannot change: make a new bucket with the ENAM hint, before anything is stored in it",
    );
  }
  return f.ok(
    id,
    `the bucket ${name} exists${bucket.location ? ` (${bucket.location.toUpperCase()})` : ""}`,
  );
}

function managedLine(
  id: string,
  name: string,
  bucket: BucketObserved,
  env: EnvironmentName,
): Finding {
  if (!bucket.managed) return f.fail(id, `Cloudflare did not say whether r2.dev serves ${name}`);
  return bucket.managed.enabled
    ? f.fail(
        id,
        `r2.dev serves ${name} at a second public address`,
        `Cloudflare › R2 › ${name} › Settings › Public Development URL: disable (${SETUP(env)})`,
      )
    : f.ok(id, `r2.dev is off for ${name}`);
}

function evaluateToken(desired: CloudflareDesired, tokens: CloudflareObserved["tokens"]): Finding {
  const { env } = desired;
  const mine = bucketNames(desired);
  if (!Array.isArray(tokens)) {
    return f.fail(
      "r2.token",
      `Cloudflare refused to list the account's API tokens (${tokens.refused})`,
      "give the check's read-only token Account API Tokens Read (docs/production.md › Checking production)",
    );
  }
  if (!mine.length) return f.pending("r2.token", `infra names no bucket for ${env} yet`);
  const active = tokens.filter((t) => t.active);
  const reaching = active.filter((t) => t.buckets.some((b) => mine.includes(b)));
  const tooWide = reaching.filter((t) => t.buckets.some((b) => !mine.includes(b)));
  const fix = `Cloudflare › R2 › Manage API tokens: an Account API token, Object Read & Write, on ${list(mine)} only (${SETUP(env)})`;
  if (tooWide.length) {
    const also = sorted(tooWide.flatMap((t) => t.buckets.filter((b) => !mine.includes(b))));
    return f.fail("r2.token", `a token that reaches ${list(mine)} also reaches ${list(also)}`, fix);
  }
  const exact = reaching.filter((t) => mine.every((b) => t.buckets.includes(b)));
  if (exact.length) return f.ok("r2.token", `an R2 token reaches exactly ${list(mine)}`);
  const says = reaching.length
    ? `no single R2 token reaches all of ${list(mine)}`
    : `no account token is scoped to ${list(mine)}`;
  // Dev's token may be a user token, which an account listing does not show; a person confirms.
  return env === "production"
    ? f.pending("r2.token", says, fix)
    : f.manual(
        "r2.token",
        `${says}; confirm the API's R2 token is scoped to ${list(mine)} only (a user token is not listed)`,
        fix,
      );
}

/** An enabled rule that sets every header to its value on the host, or why none does. */
function evaluateHeaders(desired: CloudflareDesired, zone: CloudflareObserved["zone"]): Finding {
  const { env, headers } = desired;
  const { host } = headers;
  if (!zone) {
    return f.fail(
      "headers",
      `the zone ${headers.zone} is not visible to the check's token`,
      "give the check's token Zone Read and Transform Rules Read on ponzu.cloud",
    );
  }
  const forHost = zone.rules.filter(
    (r) =>
      r.action === "rewrite" && r.enabled !== false && (r.expression ?? "").includes(`"${host}"`),
  );
  const wrong = (rule: z.infer<typeof RawRule>) => {
    const set = Object.fromEntries(
      Object.entries(rule.action_parameters?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return Object.entries(headers.values)
      .filter(([name, value]) => {
        const h = set[name.toLowerCase()];
        return !h || h.operation !== "set" || h.value !== value;
      })
      .map(([name]) => name);
  };
  const best = forHost
    .map((rule) => ({ rule, wrong: wrong(rule) }))
    .sort((a, b) => a.wrong.length - b.wrong.length)[0];
  if (best && !best.wrong.length) {
    return f.ok("headers", `a transform rule sets ${list(Object.keys(headers.values))} on ${host}`);
  }
  if (best) {
    return f.fail(
      "headers",
      `the transform rule on ${host} does not set ${list(best.wrong)} as infra/cloudflare/assets-headers.json says`,
      APPLY_HEADERS(env),
    );
  }
  if (!headers.required) {
    return f.ok(
      "headers",
      `no transform rule on ${host}, which ${env} may go without (founder step B6)`,
    );
  }
  return env === "production"
    ? f.pending("headers", `no transform rule sets the headers on ${host} yet`, APPLY_HEADERS(env))
    : f.fail("headers", `no transform rule sets the headers on ${host}`, APPLY_HEADERS(env));
}

function age(value: number | string): string {
  if (typeof value === "string") return `the date ${value}`;
  const d = value / 86_400;
  return Number.isInteger(d) ? `${d} day${d === 1 ? "" : "s"}` : `${value} s`;
}

export const cloudflareSection: Section<CloudflareDesired, CloudflareObserved> = {
  area: "cloudflare",
  needs: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  desired: cloudflareDesired,
  fetchObserved: fetchCloudflare,
  evaluate: evaluateCloudflare,
};
