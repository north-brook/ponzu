#!/usr/bin/env bun
/**
 * Builds the cloud API the way Vercel does (apps/api/vercel.json runs the same `build`) and
 * loads the bundle in Node, the runtime it is served on. The API's tests run its TypeScript
 * under Bun, so they cannot see a bundle that does not load: an import the bundler cannot
 * follow, something only Bun has, a module that needs more than the environment to start.
 *
 *   bun scripts/ci/api-bundle.ts
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const api = resolve(import.meta.dir, "../../apps/api");

function run(command: string, args: string[], env: Record<string, string> = {}) {
  const out = spawnSync(command, args, {
    cwd: api,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (out.status !== 0) process.exit(out.status ?? 1);
}

run("bun", ["run", "build"]);

// Placeholders that are well formed. Nothing below reaches a service.
const environment = {
  DATABASE_URL: "postgres://user:password@database.invalid/ponzu",
  WORKOS_API_KEY: "sk_test_placeholder",
  WORKOS_CLIENT_ID: "client_placeholder",
  GITHUB_APP_CLIENT_ID: "Iv23placeholder",
  GITHUB_APP_CLIENT_SECRET: "placeholder",
  GITHUB_APP_PRIVATE_KEY:
    "-----BEGIN RSA PRIVATE KEY-----\nplaceholder\n-----END RSA PRIVATE KEY-----",
  GITHUB_APP_SLUG: "placeholder",
  GITHUB_WEBHOOK_SECRET: "placeholder".repeat(4),
  CRON_SECRET: "placeholder".repeat(4),
  PONZU_VAULT_KEY: Buffer.alloc(32, 1).toString("base64url"),
  NEON_REALTIME_URL: "https://realtime.invalid/",
  // Shaped as Neon issues one: its prefix, then an AES-256 key in base64url.
  NEON_REALTIME_SECRET: `nrt_live_1${Buffer.alloc(32, 2).toString("base64url")}`,
  PONZU_ASSETS_URL: "https://assets.invalid",
  GITHUB_APP_BOT_USER_ID: "1",
  R2_ACCOUNT_ID: "0".repeat(32),
  R2_ACCESS_KEY_ID: "placeholder",
  R2_SECRET_ACCESS_KEY: "placeholder",
  R2_BUCKET: "placeholder",
  PONZU_ANTHROPIC_API_KEY: "sk-ant-placeholder",
};

const check = `
  const { default: app } = await import("./dist/index.js");
  const expectJson = async (path, status, code) => {
    const response = await app.request(path);
    const body = await response.json();
    if (response.status !== status || body.error?.code !== code) {
      throw new Error(path + " answered " + response.status + " " + JSON.stringify(body));
    }
  };
  await expectJson("/v1/me", 401, "unauthenticated");
  await expectJson("/nowhere", 404, "not_found");
  console.log("The API bundle loads in Node " + process.versions.node + " and answers.");
`;
run("node", ["--input-type=module", "--eval", check], environment);
