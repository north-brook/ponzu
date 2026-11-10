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
  BOAT_API_KEY: "placeholder",
  PONZU_VAULT_KEY: Buffer.alloc(32, 1).toString("base64url"),
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
  // A promise nobody awaited, rejecting: Node ends the process for that unless the entry has
  // said otherwise, and an instance is serving other requests when it happens.
  Promise.reject(new Error("a stray rejection, made by scripts/ci/api-bundle.ts"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expectJson("/nowhere", 404, "not_found");
  console.log("The API bundle loads in Node " + process.versions.node + ", answers, and outlives a stray rejection.");
`;
run("node", ["--input-type=module", "--eval", check], environment);
