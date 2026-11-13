#!/usr/bin/env bun
/**
 * Builds the cloud API the way Vercel does (apps/api/vercel.json runs the same `build`) and
 * loads the bundle in Node, the runtime it is served on. The API's tests run its TypeScript
 * under Bun, so they cannot see a bundle that does not load: an import the bundler cannot
 * follow, something only Bun has, a module that needs more than the environment to start.
 * Then it checks what @ponzu/email brings in (React in production, no Tailwind, Prism or
 * marked), and renders an email from a bundle built the same way, in Node.
 *
 *   bun scripts/ci/api-bundle.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

/*
 * @ponzu/email inlines React and react-email into the bundle. React picks its development build
 * when NODE_ENV is not "production" (apps/api/scripts/build.ts defines it), and react-email
 * carries Tailwind, Prism and marked for components Ponzu never uses, which tree-shaking should
 * leave out. Bun writes each bundled module's path as a comment, so a path is proof it is in.
 */
const dist = join(api, "dist");
const sources = readdirSync(dist, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".js"))
  .map((file) => ({ file, text: readFileSync(join(dist, file), "utf8") }));
const FORBIDDEN: [string, RegExp][] = [
  ["React's development build", /react(-dom-server\.node|-dom|-jsx-runtime)?\.development\.js/],
  ["Tailwind", /node_modules\/(\.bun\/)?tailwindcss[@/]/],
  ["Prism", /node_modules\/(\.bun\/)?prismjs[@/]/],
  ["marked", /node_modules\/(\.bun\/)?marked[@/]/],
];
for (const { file, text } of sources) {
  for (const [what, pattern] of FORBIDDEN) {
    if (pattern.test(text)) {
      console.error(`dist/${file} carries ${what}.`);
      process.exit(1);
    }
  }
}
if (!sources.some(({ text }) => /react-dom-server\.node\.production\.js/.test(text))) {
  console.error("dist carries no React production server build: is @ponzu/email still in it?");
  process.exit(1);
}
const bytes = readdirSync(dist, { recursive: true, encoding: "utf8" })
  .map((file) => statSync(join(dist, file)))
  .filter((stat) => stat.isFile())
  .reduce((sum, stat) => sum + stat.size, 0);
console.log(`dist is ${(bytes / 1024 / 1024).toFixed(2)} MB, with no development React,`);
console.log("Tailwind, Prism or marked.");

// One email rendered from a bundle built with the API's options, run in Node.
const out = mkdtempSync(join(tmpdir(), "ponzu-email-bundle-"));
try {
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "api-bundle-email.ts")],
    outdir: out,
    target: "node",
    format: "esm",
    external: ["hono", "hono/*"],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }
  const rendered = spawnSync("node", [join(out, "api-bundle-email.js")], { encoding: "utf8" });
  if (rendered.status !== 0) {
    console.error(rendered.stderr);
    process.exit(rendered.status ?? 1);
  }
  const email = JSON.parse(rendered.stdout) as { subject: string; html: string; node: string };
  const subject = "Kettle onboarding and Northbrook's plan: 3 things since yesterday";
  if (email.subject !== subject || !email.html.includes("Kettle onboarding")) {
    console.error(`The bundled render answered ${JSON.stringify(email.subject)}.`);
    process.exit(1);
  }
  console.log(`A bundle built the same way renders the digest in Node ${email.node}.`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
