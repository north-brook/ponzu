/**
 * The Cloudflare areas of the apply script, through the official `cloudflare` SDK:
 *
 * - `r2`: the assets bucket's CORS (`r2.buckets.cors.update`) and lifecycle
 *   (`r2.buckets.lifecycle.update`) set to infra/r2/cors.json and infra/r2/lifecycle.json.
 *   Setting the file's lifecycle also removes any live rule that would delete under `private/`.
 *   The buckets, their domains and r2.dev are the founder's (D4).
 * - `cloudflare-headers`: the response header transform rule on the environment's assets host
 *   (`rulesets.phases.update` on the zone's `http_response_headers_transform` phase). A phase's
 *   entrypoint is replaced whole, so every other rule in it is sent back as it is, by id.
 *
 * What is live is read with the check's readers (checks/cloudflare.ts).
 */
import Cloudflare from "cloudflare";
import { z } from "zod";
import {
  cloudflareClient,
  cloudflareDesired,
  evaluateCloudflare,
  fetchCloudflare,
  normalizeCors,
  normalizeLifecycle,
  plainCloudflareError,
} from "../checks/cloudflare.ts";
import { type ApplyArea, type ApplyContext, type Change, type Plan, pick } from "./area.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const HEADERS_PHASE = "http_response_headers_transform";

async function write(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    throw plainCloudflareError(error);
  }
}

// --- r2 -----------------------------------------------------------------------------------------

export async function planR2(ctx: ApplyContext): Promise<Plan> {
  const desired = cloudflareDesired(ctx);
  if (!desired.assets) {
    return { notes: [`infra names no assets bucket for ${ctx.env} yet`], changes: [] };
  }
  const bucket = desired.assets;
  const observed = (await fetchCloudflare(ctx, desired)).buckets[bucket];
  if (!observed?.exists) {
    return {
      notes: [`the bucket ${bucket} does not exist; apply does not make buckets (founder step D4)`],
      changes: [],
    };
  }
  const account = ctx.credentials.CLOUDFLARE_ACCOUNT_ID as string;
  const cf = cloudflareClient(ctx);
  const notes: string[] = [];
  const changes: Change[] = [];
  const base = `${CLOUDFLARE_API}/accounts/${account}/r2/buckets/${bucket}`;

  const cors = { rules: desired.cors.rules };
  if (JSON.stringify(observed.cors) !== JSON.stringify(normalizeCors(cors))) {
    changes.push({
      says: `${bucket}'s CORS ${observed.cors?.length ? "differs from" : "is not"} infra/r2/cors.json's`,
      request: { method: "PUT", url: `${base}/cors`, body: cors },
      send: () => write(() => cf.r2.buckets.cors.update(bucket, { account_id: account, ...cors })),
    });
  } else {
    notes.push(`${bucket}'s CORS is infra/r2/cors.json's`);
  }

  const lifecycle = { rules: desired.lifecycle.rules };
  const live = observed.lifecycle ?? [];
  const want = normalizeLifecycle(lifecycle);
  if (JSON.stringify(live) !== JSON.stringify(want)) {
    changes.push({
      says: `${bucket}'s lifecycle has ${live.length} rule${live.length === 1 ? "" : "s"} that differ from infra/r2/lifecycle.json's ${want.length}; replace them`,
      request: { method: "PUT", url: `${base}/lifecycle`, body: lifecycle },
      send: () =>
        write(() => cf.r2.buckets.lifecycle.update(bucket, { account_id: account, ...lifecycle })),
    });
  } else {
    notes.push(`${bucket}'s lifecycle is infra/r2/lifecycle.json's`);
  }
  if (typeof desired.private === "string") {
    notes.push(
      `${desired.private} gets no CORS and no lifecycle rule (program §5.15); the check confirms it`,
    );
  }
  return { notes, changes };
}

export const r2Area: ApplyArea = {
  name: "r2",
  needs: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  plan: planR2,
  async verify(ctx) {
    const desired = cloudflareDesired(ctx);
    const lines = evaluateCloudflare(desired, await fetchCloudflare(ctx, desired));
    return pick(lines, ["cloudflare.r2.assets.cors", "cloudflare.r2.assets.lifecycle"]);
  },
};

// --- cloudflare-headers -------------------------------------------------------------------------

/** A live rule as it is sent back: its id and the fields a rule is written with. */
const LiveRule = z
  .object({
    id: z.string().optional(),
    action: z.string().optional(),
    expression: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    action_parameters: z.record(z.string(), z.unknown()).optional(),
    logging: z.unknown().optional(),
    ref: z.string().optional(),
  })
  .passthrough();
type LiveRule = z.infer<typeof LiveRule>;

/** Fields a rule is read with that a write does not take. */
const READ_ONLY = ["version", "last_updated", "categories"];

function writable(rule: LiveRule): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rule).filter(([key]) => !READ_ONLY.includes(key)));
}

/** The rule infra/cloudflare/assets-headers.json asks for on `host`. */
export function headersRule(host: string, headers: Record<string, string>) {
  return {
    action: "rewrite",
    expression: `(http.host eq "${host}")`,
    description: `Ponzu: the asset host's headers (infra/cloudflare/assets-headers.json) on ${host}`,
    enabled: true,
    action_parameters: {
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, { operation: "set", value }]),
      ),
    },
  };
}

/** Reads the zone's id and the phase's live rules (an empty list when the phase has none). */
async function readZone(
  ctx: ApplyContext,
  zone: string,
): Promise<{ zoneId: string; rules: LiveRule[] } | null> {
  const cf = cloudflareClient(ctx);
  try {
    const zones = await cf.zones.list({ name: zone });
    const zoneId = zones.result.find((z) => z.name === zone)?.id;
    if (!zoneId) return null;
    let rules: unknown[] = [];
    try {
      rules = (await cf.rulesets.phases.get(HEADERS_PHASE, { zone_id: zoneId })).rules ?? [];
    } catch (error) {
      if (!(error instanceof Cloudflare.NotFoundError)) throw error;
    }
    return { zoneId, rules: rules.map((r) => LiveRule.parse(r)) };
  } catch (error) {
    throw plainCloudflareError(error);
  }
}

export async function planHeaders(ctx: ApplyContext): Promise<Plan> {
  const desired = cloudflareDesired(ctx);
  const { host, zone, values } = desired.headers;
  const read = await readZone(ctx, zone);
  if (!read) {
    return {
      notes: [
        `the zone ${zone} is not visible to the token; it needs Zone Read and Transform Rules Edit`,
      ],
      changes: [],
    };
  }
  const evaluated = evaluateCloudflare(desired, {
    buckets: {},
    zone: { rules: read.rules as never },
    tokens: [],
  }).find((l) => l.id === "cloudflare.headers");
  const want = headersRule(host, values);
  const ours = (r: LiveRule) =>
    r.action === "rewrite" && (r.expression ?? "").includes(`"${host}"`);
  const mine = read.rules.filter(ours);
  const matches = evaluated?.status === "ok" && mine.length > 0;
  if (matches) {
    return {
      notes: [`a transform rule already sets ${Object.keys(values).join(" and ")} on ${host}`],
      changes: [],
    };
  }
  // Every other rule stays as it is, in its place: order decides which rule's header wins. Rules
  // on this host become the one infra describes, at the first one's position and keeping its id
  // so its history in the dashboard carries on; a new rule goes last.
  const others = read.rules.filter((r) => !ours(r)).map(writable);
  const keepId = mine[0]?.id;
  const firstMine = read.rules.findIndex(ours);
  const rules: unknown[] = [];
  read.rules.forEach((r, i) => {
    if (!ours(r)) rules.push(writable(r));
    else if (i === firstMine) rules.push(keepId ? { id: keepId, ...want } : want);
  });
  if (firstMine === -1) rules.push(want);
  const body = { rules };
  const cf = cloudflareClient(ctx);
  return {
    notes: others.length
      ? [
          `${others.length} other rule${others.length === 1 ? "" : "s"} in the zone's ${HEADERS_PHASE} phase ${others.length === 1 ? "is" : "are"} sent back unchanged`,
        ]
      : [],
    changes: [
      {
        says: mine.length
          ? `the transform rule on ${host} does not set the headers infra names; replace it`
          : `no transform rule sets the headers on ${host}; add one`,
        request: {
          method: "PUT",
          url: `${CLOUDFLARE_API}/zones/${read.zoneId}/rulesets/phases/${HEADERS_PHASE}/entrypoint`,
          body,
        },
        send: () =>
          write(() =>
            cf.rulesets.phases.update(HEADERS_PHASE, {
              zone_id: read.zoneId,
              rules: rules as never,
            }),
          ),
      },
    ],
  };
}

export const headersArea: ApplyArea = {
  name: "cloudflare-headers",
  needs: ["CLOUDFLARE_API_TOKEN"],
  plan: planHeaders,
  async verify(ctx) {
    const desired = cloudflareDesired(ctx);
    const read = await readZone(ctx, desired.headers.zone);
    const lines = evaluateCloudflare(desired, {
      buckets: {},
      zone: read ? { rules: read.rules as never } : null,
      tokens: [],
    });
    return pick(lines, ["cloudflare.headers"]);
  },
};
