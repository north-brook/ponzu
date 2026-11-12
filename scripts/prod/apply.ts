#!/usr/bin/env bun
/**
 * The apply script (docs/production.md, "Applying the desired state"): makes one area of an
 * environment what `infra/` says, so the founder runs a command instead of clicking.
 *
 *   bun scripts/prod/apply.ts <area> --env dev|production [--yes]
 *   bun scripts/prod/apply.ts secrets generate --names PONZU_VAULT_KEY,CRON_SECRET --env <env> [--yes]
 *   bun scripts/prod/apply.ts github-rulesets [--yes]
 *
 * Areas: vercel-project, vercel-env, secrets, firewall, neon, r2, cloudflare-headers, posthog,
 * github-rulesets (apply/*.ts).
 *
 * Without `--yes` it reads (GETs only), prints what it would change, each change as the exact
 * request it would send, and changes nothing. With `--yes` it sends those requests in order, then
 * reads the area again and requires the check's lines for it to be `ok`; it exits 0 only then.
 *
 * Credentials come from the environment of whoever runs it, as for the check, but with write
 * access. Every printed line goes through `@ponzu/core/redact` with every credential present, and
 * every value apply generates, as a known secret. `secrets generate` makes each value in memory,
 * sends it straight to Vercel as `sensitive`, and never prints it or writes it anywhere else.
 *
 * Agents run it only without `--yes`; applying to production is the founder's.
 */
import { redactText } from "../../packages/core/src/redact.ts";
import { type ApplyArea, type ApplyContext, formatBody } from "./apply/area.ts";
import { headersArea, r2Area } from "./apply/cloudflare.ts";
import { rulesetsArea } from "./apply/github.ts";
import { neonArea } from "./apply/neon.ts";
import { posthogArea } from "./apply/posthog.ts";
import {
  firewallArea,
  secretNames,
  secretsArea,
  vercelEnvArea,
  vercelProjectArea,
} from "./apply/vercel.ts";
import { formatFinding, type Io, readCredentials } from "./check.ts";
import { describeError } from "./checks/finding.ts";
import { EnvironmentName, loadInfra } from "./desired.ts";

/** Every area, by the name the command line takes. */
export const AREAS: readonly ApplyArea[] = [
  vercelProjectArea,
  vercelEnvArea,
  secretsArea,
  firewallArea,
  neonArea,
  r2Area,
  headersArea,
  posthogArea,
  rulesetsArea,
];

export const USAGE = [
  "usage: bun scripts/prod/apply.ts <area> --env <dev|production> [--yes]",
  `  areas: ${AREAS.map((a) => a.name).join(", ")}`,
  "  bun scripts/prod/apply.ts secrets generate --names PONZU_VAULT_KEY,CRON_SECRET --env <env> [--yes]",
  "  bun scripts/prod/apply.ts github-rulesets [--yes]   (the repository's; no --env needed)",
].join("\n");

interface Parsed {
  area: ApplyArea;
  env: EnvironmentName;
  yes: boolean;
  args: string[];
}

/** The command line, or why it is not one. */
export function parseArgs(argv: readonly string[], areas = AREAS): Parsed | string {
  const [name, ...rest] = argv;
  const area = areas.find((a) => a.name === name);
  if (!area) return name ? `no area "${name}"` : "no area given";
  const envAt = rest.indexOf("--env");
  const envArg = envAt === -1 ? undefined : rest[envAt + 1];
  const yes = rest.includes("--yes");
  const args = rest.filter(
    (arg, i) => arg !== "--yes" && (envAt === -1 || (i !== envAt && i !== envAt + 1)),
  );
  const env = EnvironmentName.safeParse(envArg ?? (area.envless ? "dev" : undefined));
  if (!env.success) return `--env must be dev or production`;
  if (area.name === "secrets") {
    try {
      secretNames(args);
    } catch (error) {
      return describeError(error);
    }
  } else if (args.length) {
    return `unexpected ${args.join(" ")}`;
  }
  return { area, env: env.data, yes, args };
}

const realIo: Io = {
  print: (line) => console.log(line),
  env: process.env,
  fetch: globalThis.fetch,
  now: () => new Date(),
};

/** Runs the command line; returns the exit code. Every line goes through the redactor. */
export async function main(
  argv: readonly string[],
  io: Io = realIo,
  areas: readonly ApplyArea[] = AREAS,
): Promise<number> {
  const parsed = parseArgs(argv, areas);
  if (typeof parsed === "string") {
    io.print(`${parsed}\n${USAGE}`);
    return 2;
  }
  const { area, env, yes, args } = parsed;
  const credentials = readCredentials(io.env);
  // Credentials, and every value an area makes, are taken out of every line printed.
  const known: string[] = Object.values(credentials).filter((v): v is string => !!v);
  const print = (line: string) => io.print(redactText(line, known));
  const where = area.envless ? "the repository" : env;
  print(
    `Ponzu ${where}: apply ${area.name} ${yes ? "(--yes: changing what differs)" : "(dry run: nothing is changed; --yes applies)"}`,
  );

  const missing = area.needs.filter((n) => !credentials[n]);
  if (area.needsOneOf && !area.needsOneOf.some((n) => credentials[n])) {
    missing.push(...area.needsOneOf);
  }
  if (missing.length) {
    print(`skipped (no ${missing.join(", no ")}): nothing was read or changed`);
    return 1;
  }

  const ctx: ApplyContext = {
    env,
    infra: loadInfra(),
    credentials,
    fetch: io.fetch,
    now: io.now,
    deep: false,
    args,
    secret: (value) => {
      known.push(value);
    },
  };

  let plan: Awaited<ReturnType<ApplyArea["plan"]>>;
  try {
    plan = await area.plan(ctx);
  } catch (error) {
    print(`fail    could not be read: ${describeError(error)}`);
    return 1;
  }
  for (const note of plan.notes) print(`  =  ${note}`);
  for (const change of plan.changes) {
    print(`  ~  ${change.says}`);
    print(`     ${change.request.method} ${change.request.url}`);
    for (const line of formatBody(change.request.body)) print(line);
  }
  const count = `${plan.changes.length} change${plan.changes.length === 1 ? "" : "s"}`;
  if (!yes) {
    print(
      plan.changes.length
        ? `${count}; nothing was changed. Run again with --yes to apply.`
        : "nothing to change.",
    );
    return 0;
  }

  for (const [i, change] of plan.changes.entries()) {
    try {
      await change.send();
      print(
        `sent    ${i + 1}/${plan.changes.length}: ${change.request.method} ${change.request.url}`,
      );
    } catch (error) {
      print(`fail    ${change.request.method} ${change.request.url}: ${describeError(error)}`);
      print(`stopped after ${i} of ${count}.`);
      return 1;
    }
  }
  if (!area.verify) return 0;
  let lines: Awaited<ReturnType<NonNullable<ApplyArea["verify"]>>>;
  try {
    lines = await area.verify(ctx);
  } catch (error) {
    print(`fail    could not be read again: ${describeError(error)}`);
    return 1;
  }
  print("read again:");
  for (const finding of lines) for (const line of formatFinding(finding)) print(line);
  const ok = lines.length > 0 && lines.every((f) => f.status === "ok");
  print(ok ? `${area.name} is as infra/ says.` : `${area.name} is not yet as infra/ says.`);
  return ok ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        redactText(describeError(error), Object.values(readCredentials(process.env)) as string[]),
      );
      process.exit(1);
    },
  );
}
