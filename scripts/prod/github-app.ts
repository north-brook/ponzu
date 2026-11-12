#!/usr/bin/env bun
/**
 * Creates an environment's GitHub App from its manifest (docs/production.md, "The GitHub App
 * `ponzu`" and founder step D6), so the founder clicks one button on GitHub instead of filling in
 * a form, and no secret passes through a person's clipboard on its way to Vercel.
 *
 *   bun scripts/prod/github-app.ts create --env production --workos-callback <url>
 *   bun scripts/prod/github-app.ts create --env dev --dry-run      (prints the form; no request)
 *
 * What it does, in order:
 *
 * 1. Reads, and refuses to go on when anything is in the way: the environment's Vercel project
 *    must exist, none of the App's variables may be set on its Production target yet, and GitHub
 *    must show no public App by the slug infra names.
 * 2. Serves one page on 127.0.0.1 that posts GitHub's manifest form, carrying
 *    `infra/github-app/<slug>.json` plus `redirect_url` (back to that page) and `callback_urls`
 *    (WorkOS's GitHub callback), to `github.com/organizations/<owner>/settings/apps/new` with a
 *    random `state`. The founder clicks "Create GitHub App" there.
 * 3. GitHub sends the browser back with a `code`. A request whose `state` is not this run's is
 *    refused and the page keeps waiting. The code goes to `POST /app-manifests/{code}/conversions`,
 *    whose answer holds the App's client secret, private key and webhook secret. Each is handed
 *    to the redactor before anything else reads the answer.
 * 4. Looks up the App's bot user (`GET /users/<slug>[bot]`), then writes
 *    `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` as
 *    `sensitive`, and `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_BOT_USER_ID` and `GITHUB_APP_SLUG` as
 *    plain (public) values, to the Production target in one request, then reads the names back.
 * 5. Prints only the slug, the App id and the client id. WorkOS also needs the client secret
 *    (founder step D7), so that one value is put in a file only its owner can read, in a new
 *    directory under the temporary directory, and deleted when the founder presses Enter.
 *
 * Nothing else is printed or written anywhere: every printed line goes through the redactor
 * with every credential and every secret GitHub sent as known secrets, and a vendor's refusal
 * prints only its status.
 *
 * Agents run it only with `--dry-run`. Creating an App is the founder's.
 */
import { timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { redactText } from "../../packages/core/src/redact.ts";
import type { ApplyContext } from "./apply/area.ts";
import { type LiveEnv, readEnv, write } from "./apply/vercel.ts";
import { type Io, readCredentials } from "./check.ts";
import { type CheckContext, describeError } from "./checks/finding.ts";
import { appManifest, githubClient, githubStatus, readApp } from "./checks/github.ts";
import { readProjectId, team, vercelClient, vercelDesired } from "./checks/vercel.ts";
import { EnvironmentName, type GithubAppManifest, type Infra, loadInfra } from "./desired.ts";

export const USAGE = [
  "usage: bun scripts/prod/github-app.ts create --env <dev|production> --workos-callback <url>",
  "       bun scripts/prod/github-app.ts create --env <dev|production> [--workos-callback <url>] --dry-run",
].join("\n");

/** How long the page waits for GitHub. GitHub's code itself is good for an hour. */
export const CALLBACK_TIMEOUT_MS = 30 * 60_000;

/** The App's variables on the Production target, and how each is stored. */
export const APP_ENV = {
  GITHUB_APP_CLIENT_ID: "plain",
  GITHUB_APP_SLUG: "plain",
  GITHUB_APP_BOT_USER_ID: "plain",
  GITHUB_APP_CLIENT_SECRET: "sensitive",
  GITHUB_APP_PRIVATE_KEY: "sensitive",
  GITHUB_WEBHOOK_SECRET: "sensitive",
} as const;
type AppEnvName = keyof typeof APP_ENV;

/** The API refuses a shorter webhook secret at boot (apps/api/src/env.ts). */
const WEBHOOK_SECRET_MIN = 32;

// --- the command line ---------------------------------------------------------------------------

export interface Parsed {
  env: EnvironmentName;
  /** WorkOS's GitHub callback; `null` only on a dry run. */
  callback: string | null;
  dryRun: boolean;
}

const HttpsUrl = z.url({ protocol: /^https$/ });

/** The command line, or why it is not one. */
export function parseArgs(argv: readonly string[]): Parsed | string {
  const [command, ...rest] = argv;
  if (command !== "create") return command ? `no command "${command}"` : "no command given";
  let env: string | undefined;
  let callback: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--env") env = rest[++i];
    else if (arg === "--workos-callback") callback = rest[++i];
    else if (arg === "--dry-run") dryRun = true;
    else return `unexpected ${arg}`;
  }
  const name = EnvironmentName.safeParse(env);
  if (!name.success) return "--env must be dev or production";
  if (callback !== undefined && !HttpsUrl.safeParse(callback).success) {
    return "--workos-callback must be an https URL";
  }
  if (!callback && !dryRun) {
    return "--workos-callback <url> is required: WorkOS's GitHub OAuth callback (founder step D5)";
  }
  return { env: name.data, callback: callback ?? null, dryRun };
}

// --- the manifest form --------------------------------------------------------------------------

/** infra's manifest with the two fields only a run knows: where GitHub comes back, and WorkOS. */
export function manifestFor(
  base: GithubAppManifest,
  redirectUrl: string,
  callback: string | null,
): GithubAppManifest & { redirect_url: string; callback_urls?: string[] } {
  return { ...base, redirect_url: redirectUrl, ...(callback ? { callback_urls: [callback] } : {}) };
}

/** GitHub's page that creates an App in an organisation from a posted manifest. */
export function newAppUrl(owner: string, state: string): string {
  return `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new?state=${encodeURIComponent(state)}`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The loopback page: GitHub's manifest form, posted as soon as it loads. */
export function renderForm(action: string, manifest: object): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Create the GitHub App</title></head>',
    "<body>",
    `<form id="manifest" method="post" action="${escapeHtml(action)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">`,
    "<p>Taking you to GitHub to create the App. If nothing happens, press the button.</p>",
    '<button type="submit">Continue to GitHub</button>',
    "</form>",
    '<script>document.getElementById("manifest").submit()</script>',
    "</body>",
    "</html>",
  ].join("\n");
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

function sameState(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Loopback {
  /** The page to open: `http://127.0.0.1:<port>/`. */
  url: string;
  /** Where GitHub sends the browser back: `http://127.0.0.1:<port>/callback`. */
  redirectUrl: string;
  /** GitHub's code, once a request with this run's state brings one. */
  code: Promise<string>;
  stop(): void;
}

/**
 * Serves the form at `/` and waits at `/callback` on 127.0.0.1, on a port the system picks. A
 * callback with another state, or without a well-formed code, is answered 400 and does not end
 * the wait, so a stray request cannot make the run give up. A request that names another host
 * (a web page that has pointed its own name at 127.0.0.1, to read the state) is answered 404.
 */
export function startLoopback(
  state: string,
  page: (redirectUrl: string) => string,
  onRefused: () => void,
): Loopback {
  let html = "";
  let host = "";
  let done = false;
  let resolve: (code: string) => void = () => {};
  const code = new Promise<string>((r) => {
    resolve = r;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" || request.headers.get("host") !== host) {
        return new Response("Not found", { status: 404 });
      }
      if (url.pathname === "/") return new Response(html, { headers: PAGE_HEADERS });
      if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const got = url.searchParams.get("code") ?? "";
      if (!sameState(url.searchParams.get("state") ?? "", state) || !/^[\w-]{1,128}$/.test(got)) {
        onRefused();
        return new Response(
          "<!doctype html><title>Refused</title><p>This request did not come from this run. Close this tab.</p>",
          { status: 400, headers: PAGE_HEADERS },
        );
      }
      if (done) {
        return new Response("<!doctype html><title>Done</title><p>Already done.</p>", {
          status: 409,
          headers: PAGE_HEADERS,
        });
      }
      done = true;
      resolve(got);
      return new Response(
        "<!doctype html><title>Created</title><p>The App is created. Go back to the terminal.</p>",
        { headers: PAGE_HEADERS },
      );
    },
  });
  host = `127.0.0.1:${server.port}`;
  const origin = `http://${host}`;
  const redirectUrl = `${origin}/callback`;
  html = page(redirectUrl);
  // Not forced: the browser still gets the "created" page it is being answered with.
  return { url: `${origin}/`, redirectUrl, code, stop: () => void server.stop() };
}

// --- GitHub -------------------------------------------------------------------------------------

/** What `POST /app-manifests/{code}/conversions` answers, as far as this script reads it. */
export const Conversion = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  owner: z.object({ login: z.string() }).nullish(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  webhook_secret: z.string().nullish(),
  pem: z.string().includes("PRIVATE KEY-----"),
});
export type Conversion = z.infer<typeof Conversion>;

const SECRET_FIELDS = ["client_secret", "webhook_secret", "pem"] as const;

/**
 * Exchanges GitHub's code for the App's credentials, without a token (GitHub needs none). Every
 * secret in the answer goes to `hold` (the redactor) before the answer is parsed, so not even a
 * parse error could print one.
 */
export async function convert(
  ctx: Pick<CheckContext, "fetch">,
  code: string,
  hold: (value: string) => void,
): Promise<Conversion> {
  let data: unknown;
  try {
    ({ data } = await githubClient(ctx).request("POST /app-manifests/{code}/conversions", {
      code,
    }));
  } catch (error) {
    const status = githubStatus(error);
    throw new Error(
      status === null
        ? "GitHub could not be reached for the code exchange"
        : `GitHub answered ${status} for the code exchange`,
    );
  }
  const raw = (data ?? {}) as Record<string, unknown>;
  for (const field of SECRET_FIELDS) {
    const value = raw[field];
    if (typeof value === "string") {
      hold(value);
      // A PEM is many lines; each long one is a secret on its own, wherever a line break falls.
      for (const line of value.split("\n")) if (!line.startsWith("-----")) hold(line.trim());
    }
  }
  const parsed = Conversion.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(answer)"))];
    throw new Error(`GitHub's answer to the code exchange lacks or misshapes ${fields.join(", ")}`);
  }
  return parsed.data;
}

const BotUser = z.object({ id: z.number().int().positive(), type: z.literal("Bot") });

/**
 * The App's bot user id, from GitHub's public `GET /users/<slug>[bot]`; `null` when GitHub does
 * not show it after `tries` reads (it can lag the App by a moment).
 */
export async function readBotUserId(
  ctx: Pick<CheckContext, "fetch">,
  slug: string,
  sleep: (ms: number) => Promise<void>,
  tries = 3,
): Promise<number | null> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const { data } = await githubClient(ctx).request("GET /users/{username}", {
        username: `${slug}[bot]`,
      });
      const bot = BotUser.safeParse(data);
      if (bot.success) return bot.data.id;
    } catch {
      // A 404 while GitHub catches up, or a blip: tried again below.
    }
    if (attempt < tries) await sleep(2_000);
  }
  return null;
}

// --- running it ---------------------------------------------------------------------------------

export interface GithubAppIo extends Io {
  /** Opens the loopback page in the person's browser; the URL is printed too. */
  openBrowser(url: string): void;
  /** Resolves when the person presses Enter (or stdin ends). */
  waitForEnter(): Promise<void>;
  /** Where the client secret's file goes: a new directory under it. */
  tmpdir(): string;
  sleep(ms: number): Promise<void>;
  callbackTimeoutMs: number;
}

function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed; the person opens it.
  }
}

const realIo: GithubAppIo = {
  print: (line) => console.log(line),
  env: process.env,
  fetch: globalThis.fetch,
  now: () => new Date(),
  openBrowser: openInBrowser,
  async waitForEnter() {
    for await (const _line of console) return;
  },
  tmpdir,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  callbackTimeoutMs: CALLBACK_TIMEOUT_MS,
};

function randomState(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** The lines to print when the App exists but its secrets did not reach Vercel. */
function recovery(slug: string, owner: string, project: string): string[] {
  return [
    `The App ${slug} exists, but its secrets are not all on ${project}. To finish by hand:`,
    `  GitHub › ${owner} › Developer settings › GitHub Apps › ${slug} › General: generate a new client secret and a private key,`,
    `  and add them to ${project}'s Production target as sensitive GITHUB_APP_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY;`,
    "  set GITHUB_WEBHOOK_SECRET (32 random bytes) as sensitive and on the App with apps/api/scripts/github-webhook.ts configure.",
  ];
}

/** Runs the command line; returns the exit code. Every line goes through the redactor. */
export async function main(
  argv: readonly string[],
  io: GithubAppIo = realIo,
  infra: Infra = loadInfra(),
): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    io.print(`${parsed}\n${USAGE}`);
    return 2;
  }
  const { env, callback, dryRun } = parsed;
  const credentials = readCredentials(io.env);
  const known: string[] = Object.values(credentials).filter((v): v is string => !!v);
  const hold = (value: string) => {
    if (value) known.push(value);
  };
  const print = (line: string) => io.print(redactText(line, known));

  const slug = infra["environments.json"].environments[env].githubAppSlug;
  if (!slug) {
    print(`fail    infra/environments.json names no GitHub App for ${env}`);
    return 1;
  }
  const file = `github-app/${slug}.json`;
  if (!(file in infra)) {
    print(`fail    infra has no ${file}, the manifest for the App "${slug}"`);
    return 1;
  }
  const base = appManifest(infra, slug);
  const owner = infra["github/repo.json"].repository.split("/")[0] as string;
  const state = randomState();
  const action = newAppUrl(owner, state);

  if (dryRun) {
    print(
      `Ponzu ${env}: the form that creates the GitHub App "${slug}" from infra/${file} (dry run: no request is made, nothing is created)`,
    );
    const redirect = "http://127.0.0.1:<port>/callback";
    if (!callback) print("  =  callback_urls is left out: pass --workos-callback <url>");
    print(`  POST ${action}`);
    print("  the page the browser is given:");
    for (const line of renderForm(action, manifestFor(base, redirect, callback)).split("\n")) {
      print(`    ${line}`);
    }
    return 0;
  }

  print(`Ponzu ${env}: create the GitHub App "${slug}" from infra/${file}`);
  if (!credentials.VERCEL_TOKEN) {
    print("skipped (no VERCEL_TOKEN): nothing was read or created");
    return 1;
  }
  const ctx: ApplyContext = {
    env,
    infra,
    credentials,
    fetch: io.fetch,
    now: io.now,
    deep: false,
    args: [],
    secret: hold,
  };
  const project = vercelDesired(ctx).project;
  if (!project) {
    print(`fail    infra names no Vercel project for ${env} yet`);
    return 1;
  }

  // 1. Nothing in the way, before anyone is sent to GitHub.
  let slugEntry: LiveEnv | undefined;
  try {
    if ((await readProjectId(ctx, project)) === null) {
      print(
        `fail    ${project} does not exist yet: run apply.ts vercel-project --env ${env} --yes first`,
      );
      return 1;
    }
    const live = (await readEnv(ctx, project)).filter((e) => e.targets.includes("production"));
    const taken = (Object.keys(APP_ENV) as AppEnvName[]).filter(
      (name) => name !== "GITHUB_APP_SLUG" && live.some((e) => e.key === name),
    );
    if (taken.length) {
      print(
        `fail    ${taken.join(", ")} ${taken.length === 1 ? "is" : "are"} already set on ${project}'s Production target. This script makes a new App and never replaces an App's secrets; rotate them instead (docs/production.md › Rotating secrets)`,
      );
      return 1;
    }
    slugEntry = live.find((e) => e.key === "GITHUB_APP_SLUG");
    if (slugEntry && slugEntry.value !== slug) {
      print(
        `fail    GITHUB_APP_SLUG is already set on ${project}'s Production target, ${slugEntry.type === "plain" ? `to ${JSON.stringify(slugEntry.value)}` : `as ${slugEntry.type}`}, not "${slug}": remove it and run again`,
      );
      return 1;
    }
    print(`  =  ${project} exists, and none of the App's secrets is set on its Production target`);
    if (await readApp(ctx, slug)) {
      print(
        `fail    GitHub already shows a public App "${slug}": it is made. This script only makes a new one`,
      );
      return 1;
    }
    print(`  =  GitHub shows no public App "${slug}" yet`);
  } catch (error) {
    print(`fail    could not be read: ${describeError(error)}`);
    return 1;
  }

  // 2. The page, and GitHub's answer.
  let refused = 0;
  const loopback = startLoopback(
    state,
    (redirectUrl) => renderForm(action, manifestFor(base, redirectUrl, callback)),
    () => {
      refused++;
      print("  !  refused a request to the page that did not carry this run's state");
    },
  );
  print(`Open ${loopback.url} in a browser signed in to GitHub as an owner of ${owner}.`);
  print(
    `It sends you to GitHub with infra/${file}: check the name and click "Create GitHub App". Waiting up to ${Math.round(io.callbackTimeoutMs / 60_000)} minutes.`,
  );
  io.openBrowser(loopback.url);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let code: string;
  try {
    code = await Promise.race([
      loopback.code,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("GitHub did not send the browser back in time")),
          io.callbackTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    print(`fail    ${describeError(error)}; nothing was created by this script. Run it again.`);
    return 1;
  } finally {
    clearTimeout(timer);
    loopback.stop();
  }
  hold(code);

  // 3. The code for the App's credentials.
  let app: Conversion;
  try {
    app = await convert(ctx, code, hold);
  } catch (error) {
    print(`fail    ${describeError(error)}`);
    print(
      `If GitHub created the App, its credentials were not received: delete it (GitHub › ${owner} › Developer settings › GitHub Apps › ${slug} › Advanced) and run again.`,
    );
    return 1;
  }
  print(`created slug      ${app.slug}`);
  print(`        App id    ${app.id}`);
  print(`        client id ${app.client_id}`);
  if (app.owner?.login !== owner) {
    print(
      `fail    the App belongs to ${app.owner?.login ?? "no one GitHub names"}, not ${owner}; nothing was stored. Delete it (its settings › Advanced) and run again.`,
    );
    return 1;
  }

  // 4. Vercel.
  const failures: string[] = [];
  const botId = await readBotUserId(ctx, app.slug, io.sleep);
  if (botId === null) {
    failures.push(
      `GITHUB_APP_BOT_USER_ID: GitHub did not show ${app.slug}[bot]; add its id (gh api '/users/${app.slug}%5Bbot%5D' --jq .id) to ${project}'s Production target as plain`,
    );
  }
  const webhookOk = (app.webhook_secret ?? "").length >= WEBHOOK_SECRET_MIN;
  if (!webhookOk) {
    failures.push(
      `GITHUB_WEBHOOK_SECRET: GitHub's answer held ${app.webhook_secret ? "a webhook secret shorter than the API accepts" : "no webhook secret"}; make one of 32 random bytes, add it as sensitive and set it on the App with apps/api/scripts/github-webhook.ts configure`,
    );
  }
  const values: Partial<Record<AppEnvName, string>> = {
    GITHUB_APP_CLIENT_ID: app.client_id,
    ...(slugEntry ? {} : { GITHUB_APP_SLUG: app.slug }),
    ...(botId === null ? {} : { GITHUB_APP_BOT_USER_ID: String(botId) }),
    GITHUB_APP_CLIENT_SECRET: app.client_secret,
    GITHUB_APP_PRIVATE_KEY: app.pem,
    ...(webhookOk ? { GITHUB_WEBHOOK_SECRET: app.webhook_secret as string } : {}),
  };
  const entries = (Object.entries(values) as [AppEnvName, string][]).map(([key, value]) => ({
    key,
    value,
    type: APP_ENV[key],
    target: ["production" as const],
  }));
  const vercel = vercelClient(ctx);
  let stored = true;
  try {
    await write("storing the App's variables", () =>
      vercel.projects.createProjectEnv({ idOrName: project, ...team(ctx), requestBody: entries }),
    );
    if (slugEntry && slugEntry.value !== app.slug) {
      const id = slugEntry.id;
      await write("changing GITHUB_APP_SLUG", () =>
        vercel.projects.editProjectEnv({
          idOrName: project,
          id,
          ...team(ctx),
          requestBody: { value: app.slug },
        }),
      );
    }
  } catch (error) {
    stored = false;
    print(`fail    ${describeError(error)}`);
    for (const line of recovery(app.slug, owner, project)) print(line);
  }

  // Read back: names and types only; Vercel never hands a sensitive value back. Vercel can
  // accept the request and still refuse some of its variables (its answer's `failed` list), so
  // a secret missing here needs the same hand finish as a refused request.
  let ok = stored;
  let secretMissing = false;
  if (stored) {
    try {
      const live = (await readEnv(ctx, project)).filter((e) => e.targets.includes("production"));
      for (const { key, type } of entries) {
        const entry = live.find((e) => e.key === key);
        if (entry?.type === type) {
          print(`ok      ${key} is on ${project}'s Production target, stored as ${type}`);
        } else {
          ok = false;
          if (type === "sensitive") secretMissing = true;
          print(
            `fail    ${key} ${entry ? `is stored as ${entry.type}, not ${type}` : "is not on the Production target"}`,
          );
        }
      }
    } catch (error) {
      ok = false;
      print(`fail    the variables could not be read back: ${describeError(error)}`);
    }
    if (secretMissing) for (const line of recovery(app.slug, owner, project)) print(line);
  }
  for (const line of failures) {
    ok = false;
    print(`fail    ${line}`);
  }
  if (app.slug !== slug) {
    ok = false;
    print(
      `pending GitHub named the App "${app.slug}", not "${slug}": infra/environments.json's githubAppSlug and infra/${file} must take the new slug (tell the orchestrator)`,
    );
  }

  // 5. The client secret, for WorkOS, until Enter.
  const dir = mkdtempSync(join(io.tmpdir(), "ponzu-github-app-"));
  const secretFile = join(dir, "client-secret");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  // Ctrl-C, a closed terminal or a kill: the file goes either way.
  const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  for (const signal of SIGNALS) process.once(signal, onSignal);
  try {
    writeFileSync(secretFile, app.client_secret, { mode: 0o600, flag: "wx" });
    print(
      `The client secret, for WorkOS (founder step D7), is in ${secretFile}, readable only by you.`,
    );
    print("Press Enter once it is in WorkOS, and the file is deleted.");
    await io.waitForEnter();
  } finally {
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
    cleanup();
  }
  print(`deleted ${secretFile}`);
  print(
    `Next: upload the logo on GitHub, install ${app.slug} on ${owner}/ponzu-test, and give WorkOS the client id above (D7).`,
  );
  if (refused) print(`(${refused} request${refused === 1 ? " was" : "s were"} refused on the way)`);
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
