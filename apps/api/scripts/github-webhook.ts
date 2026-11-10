// The GitHub App's webhook, as the App: where GitHub sends deliveries, with what secret, and
// sending again the ones that failed.
//
//   bun scripts/github-webhook.ts status                 where it points, and whether a secret is set
//   bun scripts/github-webhook.ts configure [--url URL]  point it at the API, signed with GITHUB_WEBHOOK_SECRET
//   bun scripts/github-webhook.ts redeliver [--since T] [--dry-run]
//                                                        send again every delivery that failed since T
//
// Needs GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH).
// `configure` also needs GITHUB_WEBHOOK_SECRET, the same value the API is deployed with; it is
// sent to GitHub and never printed. `--url` defaults to https://api.ponzu.design/v1/github/webhook.
// `--since` is an ISO time and defaults to three days ago, about as far back as GitHub keeps them.
//
// After a deploy that fixes deliveries, run `redeliver`: GitHub does not retry a failed one.
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { signAppJwt } from "../src/deps/github.ts";

const API = "https://api.github.com";
const DEFAULT_URL = "https://api.ponzu.design/v1/github/webhook";
const DAY_MS = 86_400_000;

const { env } = process;
const [command, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const privateKeyPem =
  env.GITHUB_APP_PRIVATE_KEY ??
  (env.GITHUB_APP_PRIVATE_KEY_PATH && readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8"));
if (!env.GITHUB_APP_CLIENT_ID || !privateKeyPem || !command) {
  console.error(
    "usage: GITHUB_APP_CLIENT_ID=… GITHUB_APP_PRIVATE_KEY_PATH=… bun scripts/github-webhook.ts status | configure [--url URL] | redeliver [--since ISO]",
  );
  process.exit(2);
}
const clientId = env.GITHUB_APP_CLIENT_ID;
const privateKey = createPrivateKey(privateKeyPem);

/** One call as the App. Delivery ids are past 2^53, so every `"id"` is read as text. */
async function asApp(method: string, path: string, body?: unknown) {
  const response = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${await signAppJwt({ clientId, privateKey, now: Date.now() })}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "ponzu-api-scripts",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path.split("?")[0]} answered ${response.status}`);
  const text = await response.text();
  const json = text ? JSON.parse(text.replace(/"id":\s*(\d+)/g, '"id":"$1"')) : null;
  return { json, next: /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1] };
}

interface Delivery {
  id: string;
  guid: string;
  delivered_at: string;
  status_code: number;
  event: string;
  action: string | null;
}

async function status() {
  const { json: config } = await asApp("GET", "/app/hook/config");
  console.log(`url:          ${config.url}`);
  console.log(`content type: ${config.content_type}`);
  // GitHub never returns the secret itself, only that one is set.
  console.log(`secret:       ${"secret" in config ? "set" : "not set"}`);
}

async function configure() {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("GITHUB_WEBHOOK_SECRET must be set, at least 32 characters.");
  }
  const url = option("url") ?? DEFAULT_URL;
  await asApp("PATCH", "/app/hook/config", {
    url,
    content_type: "json",
    insecure_ssl: "0",
    secret,
  });
  console.log(`The App's webhook now goes to ${url}, signed with GITHUB_WEBHOOK_SECRET.`);
}

async function redeliver() {
  const since = new Date(option("since") ?? Date.now() - 3 * DAY_MS);
  if (Number.isNaN(since.getTime())) throw new Error("--since is not a time.");

  // Newest first. A delivery that was redelivered keeps its guid, so a guid that has succeeded
  // since, on any attempt, needs nothing.
  const deliveries: Delivery[] = [];
  let page: string | undefined = "/app/hook/deliveries?per_page=100";
  while (page) {
    const { json, next }: { json: Delivery[]; next?: string } = await asApp("GET", page);
    deliveries.push(...json);
    const oldest = json.at(-1);
    page = oldest && new Date(oldest.delivered_at) >= since ? next : undefined;
  }
  const succeeded = new Set(
    deliveries.filter((d) => d.status_code >= 200 && d.status_code < 300).map((d) => d.guid),
  );
  const failed = new Map<string, Delivery>();
  for (const delivery of deliveries) {
    if (new Date(delivery.delivered_at) < since || succeeded.has(delivery.guid)) continue;
    if (!failed.has(delivery.guid)) failed.set(delivery.guid, delivery);
  }

  const dryRun = args.includes("--dry-run");
  console.log(`${failed.size} failed deliveries since ${since.toISOString()}.`);
  for (const delivery of failed.values()) {
    if (!dryRun) await asApp("POST", `/app/hook/deliveries/${delivery.id}/attempts`);
    const what = [delivery.event, delivery.action].filter(Boolean).join(".");
    const done = dryRun ? "would redeliver" : "redelivered";
    console.log(`  ${done} ${delivery.guid} ${what} (was ${delivery.status_code})`);
  }
}

const commands: Record<string, () => Promise<void>> = { status, configure, redeliver };
const run = commands[command];
if (!run) {
  console.error(`No command "${command}". Use status, configure or redeliver.`);
  process.exit(2);
}
await run();
