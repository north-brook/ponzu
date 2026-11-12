/**
 * The public names, as anyone on the internet meets them: each resolves (asked over
 * DNS-over-HTTPS, so the answer does not depend on the machine's resolver), presents a valid
 * certificate that is not about to expire, and answers as what it is. The API's domains are
 * served by Vercel; the assets host carries the header rule (`infra/cloudflare/assets-headers.json`);
 * the site answers. Needs no credential: everything here is public.
 */
import { connect } from "node:tls";
import { z } from "zod";
import type { EnvironmentName } from "../desired.ts";
import {
  type CheckContext,
  describeError,
  type Finding,
  findings,
  type Section,
} from "./finding.ts";

/** The site's own domain, shared by both environments. */
export const SITE_HOST = "ponzu.design";
/** The key the assets check asks for: no object is ever stored under it (the API's ABSENT_KEY). */
export const ABSENT_PATH = "/ponzu-selfcheck/absent";
/** A certificate this close to its end fails the check, so a renewal that stopped is caught. */
export const CERTIFICATE_DAYS = 14;
const DOH = "https://cloudflare-dns.com/dns-query";
const TIMEOUT_MS = 10_000;

export type Role = "api" | "assets" | "site";

export interface HostDesired {
  host: string;
  role: Role;
  /** Where to ask: health, the absent key, or the home page. */
  path: string;
  /** Set when infra says this name is not this environment's yet: the line is pending. */
  notYet?: string;
  /** The founder step that sets the name up, for a production name that does not answer yet. */
  createdBy?: string;
  /** For assets: each header and its exact value, and whether this environment must have them. */
  headers?: { values: Record<string, string>; required: boolean };
}

export interface DnsDesired {
  env: EnvironmentName;
  hosts: HostDesired[];
  /** Where infra disagrees with itself (assetsUrl and the header rule naming different hosts). */
  problems: string[];
}

export function dnsDesired(ctx: Pick<CheckContext, "env" | "infra">): DnsDesired {
  const { env } = ctx;
  const environments = ctx.infra["environments.json"].environments;
  const mine = environments[env];
  const other = environments[env === "dev" ? "production" : "dev"];
  const rule = ctx.infra["cloudflare/assets-headers.json"];
  const assets = rule.hosts[env];
  const hosts: HostDesired[] = mine.apiDomains.map((host) => ({
    host,
    role: "api",
    path: "/v1/health",
    // Both list it until founder step D11 moves dev off; until then it is dev's, not production's.
    ...(env === "production" && other.apiDomains.includes(host)
      ? { notYet: `${host} still serves dev until founder step D11 moves it` }
      : {}),
    createdBy: "founder step D11",
  }));
  hosts.push({
    host: assets.host,
    role: "assets",
    path: ABSENT_PATH,
    createdBy: "founder step D4",
    headers: { values: rule.headers, required: assets.required },
  });
  hosts.push({ host: SITE_HOST, role: "site", path: "/" });
  const problems: string[] = [];
  if (mine.assetsUrl && new URL(mine.assetsUrl).hostname !== assets.host) {
    problems.push(
      `environments.json's assetsUrl is ${mine.assetsUrl}, but assets-headers.json names ${assets.host}`,
    );
  }
  return { env, hosts, problems };
}

export interface HostObserved {
  host: string;
  dns: { status: number; addresses: string[] } | { error: string };
  certificate: { authorized: boolean; error: string | null; validTo: string | null } | null;
  https:
    | { status: number; server: string | null; headers: Record<string, string | null> }
    | { error: string }
    | null;
}

export interface DnsObserved {
  /** When it was read, so a certificate's remaining days are judged against that moment. */
  checkedAt: string;
  hosts: HostObserved[];
}

export type CertificateReader = (host: string) => Promise<HostObserved["certificate"]>;

/** The certificate the host presents, read without trusting it, so an invalid one is described. */
export const readCertificate: CertificateReader = (host) =>
  new Promise((resolve) => {
    const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false });
    const done = (value: HostObserved["certificate"]) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(TIMEOUT_MS, () =>
      done({ authorized: false, error: "timed out", validTo: null }),
    );
    socket.once("error", (error) =>
      done({ authorized: false, error: error.message, validTo: null }),
    );
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      done({
        authorized: socket.authorized,
        error: socket.authorizationError ? String(socket.authorizationError) : null,
        validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
      });
    });
  });

const DohAnswer = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

/** The headers the check looks at: who served it, and the assets rule's. */
const HEADER_NAMES = [
  "server",
  "content-security-policy",
  "x-content-type-options",
  "x-vercel-error",
];

async function readHost(
  ctx: CheckContext,
  want: HostDesired,
  readCert: CertificateReader,
): Promise<HostObserved> {
  let dns: HostObserved["dns"];
  try {
    const response = await ctx.fetch(`${DOH}?name=${encodeURIComponent(want.host)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = DohAnswer.parse(await response.json());
    dns = {
      status: answer.Status,
      addresses: (answer.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data),
    };
  } catch (error) {
    dns = { error: describeError(error) };
  }
  if ("error" in dns || dns.status !== 0 || !dns.addresses.length) {
    return { host: want.host, dns, certificate: null, https: null };
  }
  const certificate = await readCert(want.host);
  let https: HostObserved["https"];
  try {
    const response = await ctx.fetch(`https://${want.host}${want.path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
    https = {
      status: response.status,
      server: response.headers.get("server"),
      headers: Object.fromEntries(HEADER_NAMES.map((name) => [name, response.headers.get(name)])),
    };
  } catch (error) {
    https = { error: describeError(error) };
  }
  return { host: want.host, dns, certificate, https };
}

export async function fetchDns(
  ctx: CheckContext,
  desired: DnsDesired,
  readCert: CertificateReader = readCertificate,
): Promise<DnsObserved> {
  const checkedAt = ctx.now().toISOString();
  const wanted = desired.hosts.filter((host) => !host.notYet);
  const hosts = await Promise.all(wanted.map((host) => readHost(ctx, host, readCert)));
  return { checkedAt, hosts };
}

// --- evaluate -----------------------------------------------------------------------------------

const f = findings("dns");

export function evaluateDns(desired: DnsDesired, observed: DnsObserved): Finding[] {
  const out: Finding[] = desired.problems.map((problem) =>
    f.fail(
      "infra",
      problem,
      "make infra/environments.json and infra/cloudflare/assets-headers.json agree",
    ),
  );
  const now = new Date(observed.checkedAt).getTime();
  for (const want of desired.hosts) {
    if (want.notYet) {
      out.push(f.pending(want.host, want.notYet));
      continue;
    }
    const seen = observed.hosts.find((h) => h.host === want.host);
    out.push(seen ? judgeHost(desired.env, want, seen, now) : f.fail(want.host, "was not read"));
  }
  return out;
}

/** A name that is not set up: pending on production while its founder step is still to come. */
function notThere(env: EnvironmentName, want: HostDesired, says: string): Finding {
  return env === "production" && want.createdBy
    ? f.pending(want.host, says, want.createdBy)
    : f.fail(
        want.host,
        says,
        want.createdBy ? `docs/production.md (${want.createdBy})` : undefined,
      );
}

function judgeHost(
  env: EnvironmentName,
  want: HostDesired,
  seen: HostObserved,
  now: number,
): Finding {
  const { host } = want;
  if ("error" in seen.dns) return f.fail(host, `could not be resolved: ${seen.dns.error}`);
  if (seen.dns.status === 3) return notThere(env, want, "does not exist in DNS");
  if (seen.dns.status !== 0) return f.fail(host, `DNS answered status ${seen.dns.status}`);
  if (!seen.dns.addresses.length) return notThere(env, want, "has no address");

  const cert = seen.certificate;
  if (!cert?.authorized) {
    return f.fail(host, `presents no valid certificate${cert?.error ? `: ${cert.error}` : ""}`);
  }
  const until = cert.validTo ? new Date(cert.validTo).getTime() : Number.NaN;
  const days = Math.floor((until - now) / 86_400_000);
  if (!Number.isFinite(days) || days < CERTIFICATE_DAYS) {
    return f.fail(
      host,
      Number.isFinite(days)
        ? `its certificate expires in ${days} days`
        : "its certificate has no end date",
      "see why the domain's certificate stopped renewing (Vercel or Cloudflare)",
    );
  }
  const certificate = `certificate valid until ${(cert.validTo as string).slice(0, 10)}`;

  const https = seen.https;
  if (!https || "error" in https) {
    return f.fail(host, `could not be fetched over HTTPS: ${https ? https.error : "not asked"}`);
  }
  const server = https.server?.toLowerCase() ?? null;
  if (want.role === "api" || want.role === "site") {
    if (server !== "vercel") {
      return f.fail(host, `is served by ${https.server ?? "an unnamed server"}, not Vercel`);
    }
    if (https.status === 404 && https.headers["x-vercel-error"]) {
      return notThere(
        env,
        want,
        `reaches Vercel, but no project serves it (${https.headers["x-vercel-error"]})`,
      );
    }
    if (want.role === "site" && https.status !== 200) {
      return f.fail(host, `answers ${https.status}`);
    }
    return f.ok(host, `served by Vercel, ${certificate}, answers ${https.status}`);
  }

  // The assets host: Cloudflare in front of an R2 bucket.
  if (https.status >= 500) {
    return notThere(env, want, `answers ${https.status}: no bucket answers behind it`);
  }
  const rule = want.headers;
  const wrong = Object.entries(rule?.values ?? {})
    .filter(([name, value]) => https.headers[name.toLowerCase()] !== value)
    .map(([name]) => name);
  if (wrong.length && rule?.required) {
    return f.fail(
      host,
      `lacks the header rule: ${wrong.join(" and ")} ${wrong.length === 1 ? "is" : "are"} missing or different`,
      `bun scripts/prod/apply.ts cloudflare-headers --env ${env}`,
    );
  }
  return f.ok(
    host,
    wrong.length
      ? `resolves, ${certificate}, answers ${https.status}, without the header rule, which ${env} may go without (founder step B6)`
      : `resolves, ${certificate}, answers ${https.status} with the header rule`,
  );
}

export const dnsSection: Section<DnsDesired, DnsObserved> = {
  area: "dns",
  needs: [],
  desired: dnsDesired,
  fetchObserved: (ctx, desired) => fetchDns(ctx, desired),
  evaluate: evaluateDns,
};
