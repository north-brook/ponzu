import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeNetwork, Reply, type Routes } from "./apply/testing.ts";
import { loadInfra } from "./desired.ts";
import {
  APP_ENV,
  escapeHtml,
  type GithubAppIo,
  main,
  manifestFor,
  newAppUrl,
  parseArgs,
  renderForm,
} from "./github-app.ts";

const infra = loadInfra();
const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, "github", name), "utf8")) as Record<string, unknown>;
const vercelProject = JSON.parse(
  readFileSync(join(FIXTURES, "vercel", "dev-project.json"), "utf8"),
);

const TOKEN = "vercel-test-token-0123456789";
const CALLBACK = "https://auth.example.workos.test/sso/oauth/github/callback";
const CODE = "a1b2c3d4e5f6a7b8c9d0";

// Made here, never committed: what GitHub's conversion answer would carry.
const CLIENT_SECRET = "client-secret-0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbeef";
const WEBHOOK_SECRET = "webhook-secret-4f3e2d1c0b0a99887766554433221100aabbccdd";
const PEM_BODY = [
  "MIIEowIBAAKCAQEAfakefakefakefakefakefakefakefakefakefakefakefake01",
  "fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake02",
  "fakefakefakefakefakefakefakefakefakefake03",
];
const PEM = [
  `-----BEGIN RSA ${"PRIVATE"} KEY-----`,
  ...PEM_BODY,
  `-----END RSA ${"PRIVATE"} KEY-----`,
  "",
].join("\n");
const SECRETS = [CLIENT_SECRET, WEBHOOK_SECRET, PEM, ...PEM_BODY, CODE];

const BOT = fixture("dev-bot-user.json");

function conversion(extra: Record<string, unknown> = {}) {
  const { _recorded, ...app } = fixture("conversion.json");
  return {
    ...app,
    client_secret: CLIENT_SECRET,
    webhook_secret: WEBHOOK_SECRET,
    pem: PEM,
    ...extra,
  };
}

/** A fake GitHub and a fake Vercel on one network: ponzu-api-prod after D2, no App yet. */
function world(
  options: {
    envs?: Record<string, unknown>[];
    conversion?: unknown;
    app?: unknown;
    vercelPost?: unknown;
    project?: boolean;
  } = {},
): Routes {
  const envs = options.envs ?? [
    { id: "env_0", key: "PONZU_ENVIRONMENT", type: "plain", target: ["production"], value: "x" },
  ];
  const answered = options.conversion instanceof Reply ? options.conversion.body : undefined;
  const slug = (answered as { slug?: string } | undefined)?.slug ?? "ponzu";
  return {
    ...(options.project === false
      ? {}
      : {
          "GET /v9/projects/ponzu-api-prod": () => ({
            ...vercelProject,
            name: "ponzu-api-prod",
            id: "prj_prod",
            env: envs,
          }),
        }),
    "GET /v10/projects/ponzu-api-prod/env": () => ({ envs }),
    "POST /v10/projects/ponzu-api-prod/env":
      options.vercelPost ??
      ((s: { body: Record<string, unknown>[] }) => {
        for (const e of s.body) {
          envs.push({ ...e, id: `env_${envs.length}`, value: e.type === "plain" ? e.value : "" });
        }
        return { created: [] };
      }),
    ...(options.app ? { "GET /apps/ponzu": options.app } : {}),
    [`POST /app-manifests/${CODE}/conversions`]: options.conversion ?? new Reply(201, conversion()),
    [`GET /users/${slug}%5Bbot%5D`]: { ...BOT, login: `${slug}[bot]` },
  } as Routes;
}

const fromHtml = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The form a page holds: where it posts, and the manifest it carries. */
function readForm(html: string) {
  const action = fromHtml(
    html.match(/<form id="manifest" method="post" action="([^"]*)">/)?.[1] ?? "",
  );
  const value = html.match(/<input type="hidden" name="manifest" value="([^"]*)">/)?.[1] ?? "";
  return { action, manifest: JSON.parse(fromHtml(value)) as Record<string, unknown> };
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "github-app-test-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Browser {
  /** What the browser does once the page is open (GitHub's part included). */
  visit?: (url: string) => Promise<void>;
}

function io(
  fetch: typeof globalThis.fetch,
  env: Record<string, string>,
  browser: Browser = {},
  extra: Partial<GithubAppIo> = {},
) {
  const lines: string[] = [];
  const visits: Promise<void>[] = [];
  const opened: string[] = [];
  const secretFiles: { path: string; mode: number; text: string }[] = [];
  const out: GithubAppIo & {
    lines: string[];
    opened: string[];
    visits: Promise<void>[];
    secretFiles: typeof secretFiles;
  } = {
    lines,
    opened,
    visits,
    secretFiles,
    print: (l) => lines.push(l),
    env,
    fetch,
    now: () => new Date("2026-11-12T15:00:00Z"),
    openBrowser(url) {
      opened.push(url);
      if (browser.visit) visits.push(browser.visit(url));
    },
    async waitForEnter() {
      // The person reads the path from the last line printed and copies the secret out.
      const path = lines.at(-2)?.match(/ is in (\S+), readable only by you\.$/)?.[1] as string;
      secretFiles.push({
        path,
        mode: statSync(path).mode & 0o777,
        text: readFileSync(path, "utf8"),
      });
    },
    tmpdir: () => scratch,
    sleep: async () => {},
    callbackTimeoutMs: 10_000,
    ...extra,
  };
  return out;
}

/** The founder's browser: opens the page, sees GitHub's form, clicks Create, comes back. */
function founder(steps: { before?: (callback: string, state: string) => Promise<void> } = {}) {
  const seen: { html?: string } = {};
  return {
    seen,
    async visit(url: string) {
      const html = await (await globalThis.fetch(url)).text();
      seen.html = html;
      const { action, manifest } = readForm(html);
      const state = new URL(action).searchParams.get("state") as string;
      const back = manifest.redirect_url as string;
      await steps.before?.(back, state);
      const answer = await globalThis.fetch(`${back}?code=${CODE}&state=${state}`);
      expect(answer.status).toBe(200);
    },
  };
}

describe("the command line", () => {
  test("create, with an environment and WorkOS's https callback, or a dry run", () => {
    expect(parseArgs(["create", "--env", "production", "--workos-callback", CALLBACK])).toEqual({
      env: "production",
      callback: CALLBACK,
      dryRun: false,
    });
    expect(parseArgs(["create", "--env", "dev", "--dry-run"])).toEqual({
      env: "dev",
      callback: null,
      dryRun: true,
    });
    expect(parseArgs([])).toBe("no command given");
    expect(parseArgs(["make", "--env", "dev"])).toBe('no command "make"');
    expect(parseArgs(["create", "--env", "staging", "--dry-run"])).toBe(
      "--env must be dev or production",
    );
    expect(parseArgs(["create", "--env", "production"])).toContain("--workos-callback <url>");
    expect(
      parseArgs(["create", "--env", "production", "--workos-callback", "http://x.test/cb"]),
    ).toBe("--workos-callback must be an https URL");
    expect(parseArgs(["create", "--env", "dev", "--dry-run", "--yes"])).toBe("unexpected --yes");
  });

  test("the form's address is GitHub's new-App page for the organisation, with the state", () => {
    expect(newAppUrl("north-brook", "s t")).toBe(
      "https://github.com/organizations/north-brook/settings/apps/new?state=s%20t",
    );
  });

  test("the App's variables: its three secrets sensitive, its three public values plain", () => {
    expect(APP_ENV).toEqual({
      GITHUB_APP_CLIENT_ID: "plain",
      GITHUB_APP_SLUG: "plain",
      GITHUB_APP_BOT_USER_ID: "plain",
      GITHUB_APP_CLIENT_SECRET: "sensitive",
      GITHUB_APP_PRIVATE_KEY: "sensitive",
      GITHUB_WEBHOOK_SECRET: "sensitive",
    });
  });
});

describe("the form", () => {
  test("holds infra's manifest exactly, plus the loopback and WorkOS's callback", () => {
    const manifest = manifestFor(
      infra["github-app/ponzu.json"],
      "http://127.0.0.1:1/callback",
      CALLBACK,
    );
    expect(manifest).toEqual({
      ...infra["github-app/ponzu.json"],
      redirect_url: "http://127.0.0.1:1/callback",
      callback_urls: [CALLBACK],
    });
    const html = renderForm(newAppUrl("north-brook", "st&te"), manifest);
    const form = readForm(html);
    expect(form.action).toBe(
      "https://github.com/organizations/north-brook/settings/apps/new?state=st%26te",
    );
    expect(form.manifest).toEqual(manifest);
    expect(html).toContain('<script>document.getElementById("manifest").submit()</script>');
  });

  test("escapes what it puts in an attribute", () => {
    expect(escapeHtml(`"<a href='x'>&</a>"`)).toBe(
      "&quot;&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;&quot;",
    );
    const form = readForm(renderForm("https://x.test/", { name: `"><script>` }));
    expect(form.manifest).toEqual({ name: `"><script>` });
  });

  test("--env dev --dry-run renders dev's form and makes no request at all", async () => {
    const serve = spyOn(Bun, "serve");
    const net = fakeNetwork({});
    const out = io(net.fetch, {});
    try {
      expect(await main(["create", "--env", "dev", "--dry-run"], out, infra)).toBe(0);
      expect(serve).not.toHaveBeenCalled();
    } finally {
      serve.mockRestore();
    }
    expect(net.seen).toEqual([]);
    expect(out.opened).toEqual([]);
    expect(out.lines[0]).toBe(
      'Ponzu dev: the form that creates the GitHub App "ponzu-dev" from infra/github-app/ponzu-dev.json (dry run: no request is made, nothing is created)',
    );
    expect(out.lines[1]).toBe("  =  callback_urls is left out: pass --workos-callback <url>");
    expect(out.lines[2]).toMatch(
      /^ {2}POST https:\/\/github\.com\/organizations\/north-brook\/settings\/apps\/new\?state=[\w-]{43}$/,
    );
    const html = out.lines
      .slice(4)
      .map((l) => l.slice(4))
      .join("\n");
    expect(readForm(html).manifest).toEqual({
      ...infra["github-app/ponzu-dev.json"],
      redirect_url: "http://127.0.0.1:<port>/callback",
    });
  });
});

describe("create, against a fake GitHub and a fake Vercel", () => {
  const ARGS = ["create", "--env", "production", "--workos-callback", CALLBACK];

  test("the secrets reach only Vercel, as sensitive; stdout holds only the ids", async () => {
    const net = fakeNetwork(world());
    const browser = founder();
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, browser);
    const stdout = spyOn(process.stdout, "write");
    const stderr = spyOn(process.stderr, "write");
    const log = spyOn(console, "log");
    const error = spyOn(console, "error");
    const writeFile = spyOn(fs, "writeFileSync");
    const bunWrite = spyOn(Bun, "write");
    let code: number;
    try {
      code = await main(ARGS, out, infra);
      await Promise.all(out.visits);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(bunWrite).not.toHaveBeenCalled();
      // One file: the client secret, for WorkOS.
      expect(writeFile).toHaveBeenCalledTimes(1);
      expect(writeFile.mock.calls[0]?.[1]).toBe(CLIENT_SECRET);
      expect(writeFile.mock.calls[0]?.[2]).toEqual({ mode: 0o600, flag: "wx" });
    } finally {
      for (const spy of [stdout, stderr, log, error, writeFile, bunWrite]) spy.mockRestore();
    }
    expect(code).toBe(0);

    // The page posted infra's manifest to GitHub, with this run's loopback and WorkOS.
    const form = readForm(browser.seen.html as string);
    expect(form.manifest).toEqual({
      ...infra["github-app/ponzu.json"],
      redirect_url: `${out.opened[0]}callback`,
      callback_urls: [CALLBACK],
    });
    expect(out.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    // GitHub saw the code once and nothing secret; Vercel got every value in one request.
    const writes = net.writes();
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      `POST https://api.github.com/app-manifests/${CODE}/conversions`,
      "POST https://api.vercel.com/v10/projects/ponzu-api-prod/env",
    ]);
    expect(writes[1]?.body).toEqual([
      {
        key: "GITHUB_APP_CLIENT_ID",
        value: "Iv23liTestClientId0001",
        type: "plain",
        target: ["production"],
      },
      { key: "GITHUB_APP_SLUG", value: "ponzu", type: "plain", target: ["production"] },
      {
        key: "GITHUB_APP_BOT_USER_ID",
        value: String(BOT.id),
        type: "plain",
        target: ["production"],
      },
      {
        key: "GITHUB_APP_CLIENT_SECRET",
        value: CLIENT_SECRET,
        type: "sensitive",
        target: ["production"],
      },
      { key: "GITHUB_APP_PRIVATE_KEY", value: PEM, type: "sensitive", target: ["production"] },
      {
        key: "GITHUB_WEBHOOK_SECRET",
        value: WEBHOOK_SECRET,
        type: "sensitive",
        target: ["production"],
      },
    ]);
    for (const seen of net.seen) {
      if (seen.url.endsWith("/v10/projects/ponzu-api-prod/env") && seen.method === "POST") continue;
      const text = `${seen.url}${seen.query}${JSON.stringify(seen.body ?? null)}`;
      for (const secret of [CLIENT_SECRET, WEBHOOK_SECRET, ...PEM_BODY]) {
        expect(text).not.toContain(secret);
      }
    }

    // Printed: the slug, the App id and the client id, and no secret.
    expect(out.lines).toContain("created slug      ponzu");
    expect(out.lines).toContain("        App id    1000001");
    expect(out.lines).toContain("        client id Iv23liTestClientId0001");
    const printed = out.lines.join("\n");
    for (const secret of SECRETS) expect(printed).not.toContain(secret);
    expect(printed).not.toContain("PRIVATE KEY");
    expect(printed).not.toContain(TOKEN);
    expect(
      Object.keys(APP_ENV).map((key) => out.lines.some((l) => l.startsWith(`ok      ${key} `))),
    ).toEqual(Object.keys(APP_ENV).map(() => true));

    // The client secret sat in a file only its owner reads, and is gone after Enter.
    expect(out.secretFiles).toHaveLength(1);
    const file = out.secretFiles[0] as { path: string; mode: number; text: string };
    expect(file.path.startsWith(scratch)).toBe(true);
    expect(file.mode).toBe(0o600);
    expect(file.text).toBe(CLIENT_SECRET);
    expect(existsSync(file.path)).toBe(false);
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(out.lines).toContain(`deleted ${file.path}`);
  });

  test("a callback with another state is refused, and only this run's code is exchanged", async () => {
    const net = fakeNetwork(world());
    const browser = founder({
      async before(callback, state) {
        const forged = await globalThis.fetch(`${callback}?code=ffff0000ffff0000ffff&state=forged`);
        expect(forged.status).toBe(400);
        const none = await globalThis.fetch(`${callback}?code=${CODE}`);
        expect(none.status).toBe(400);
        const badCode = await globalThis.fetch(`${callback}?code=../x&state=${state}`);
        expect(badCode.status).toBe(400);
        // A page that points its own name at 127.0.0.1 gets neither the form nor the callback.
        const { origin, port } = new URL(callback);
        for (const path of ["/", `/callback?code=${CODE}&state=${state}`]) {
          const rebound = await globalThis.fetch(`${origin}${path}`, {
            headers: { host: `rebound.example:${port}` },
          });
          expect(rebound.status).toBe(404);
          expect(await rebound.text()).not.toContain(state);
        }
      },
    });
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, browser);
    expect(await main(ARGS, out, infra)).toBe(0);
    await Promise.all(out.visits);
    const exchanges = net.seen.filter((s) => s.url.includes("/app-manifests/"));
    expect(exchanges.map((s) => s.url)).toEqual([
      `https://api.github.com/app-manifests/${CODE}/conversions`,
    ]);
    expect(out.lines.filter((l) => l.includes("refused a request to the page")).length).toBe(3);
  });

  test("nothing but a forged callback: the run gives up, exchanges nothing, writes nothing", async () => {
    const net = fakeNetwork(world());
    const out = io(
      net.fetch,
      { VERCEL_TOKEN: TOKEN },
      {
        async visit(url) {
          const back = `${url}callback`;
          expect((await globalThis.fetch(`${back}?code=${CODE}&state=forged`)).status).toBe(400);
        },
      },
      { callbackTimeoutMs: 300 },
    );
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    expect(net.writes()).toEqual([]);
    expect(out.lines.at(-1)).toBe(
      "fail    GitHub did not send the browser back in time; nothing was created by this script. Run it again.",
    );
  });

  test("refuses before GitHub when the App's secrets are already on the project", async () => {
    const net = fakeNetwork(
      world({
        envs: [
          { id: "e1", key: "GITHUB_APP_PRIVATE_KEY", type: "sensitive", target: ["production"] },
        ],
      }),
    );
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    expect(out.opened).toEqual([]);
    expect(net.writes()).toEqual([]);
    expect(out.lines.at(-1)).toContain(
      "fail    GITHUB_APP_PRIVATE_KEY is already set on ponzu-api-prod's Production target",
    );
  });

  test("refuses before GitHub when GitHub already shows the App, or the project is missing", async () => {
    const shown = fakeNetwork(world({ app: fixture("dev-answers.json").app }));
    const out = io(shown.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    expect(out.opened).toEqual([]);
    expect(out.lines.at(-1)).toBe(
      'fail    GitHub already shows a public App "ponzu": it is made. This script only makes a new one',
    );

    const missing = fakeNetwork(world({ project: false }));
    const out2 = io(missing.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out2, infra)).toBe(1);
    expect(out2.opened).toEqual([]);
    expect(out2.lines.at(-1)).toBe(
      "fail    ponzu-api-prod does not exist yet: run apply.ts vercel-project --env production --yes first",
    );
    expect([...shown.writes(), ...missing.writes()]).toEqual([]);
  });

  test("without VERCEL_TOKEN nothing is read and no page is served", async () => {
    const net = fakeNetwork(world());
    const out = io(net.fetch, {}, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    expect(net.seen).toEqual([]);
    expect(out.opened).toEqual([]);
    expect(out.lines.at(-1)).toBe("skipped (no VERCEL_TOKEN): nothing was read or created");
  });

  test("an App made outside the organisation is not stored", async () => {
    const net = fakeNetwork(
      world({ conversion: new Reply(201, conversion({ owner: { login: "someone-else" } })) }),
    );
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    expect(net.writes().map((w) => w.url)).toEqual([
      `https://api.github.com/app-manifests/${CODE}/conversions`,
    ]);
    expect(out.lines.at(-1)).toContain("fail    the App belongs to someone-else, not north-brook");
    expect(out.secretFiles).toEqual([]);
  });

  test("a refused exchange prints only GitHub's status", async () => {
    const net = fakeNetwork(
      world({ conversion: new Reply(422, { message: `code ${CODE} expired`, pem: PEM }) }),
    );
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    expect(out.lines).toContain("fail    GitHub answered 422 for the code exchange");
    expect(net.writes()).toHaveLength(1);
    const printed = out.lines.join("\n");
    for (const secret of SECRETS) expect(printed).not.toContain(secret);
  });

  test("an answer that lacks a secret says which field, never a value", async () => {
    const net = fakeNetwork(world({ conversion: new Reply(201, conversion({ pem: "nope" })) }));
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    expect(out.lines).toContain(
      "fail    GitHub's answer to the code exchange lacks or misshapes pem",
    );
    expect(net.writes()).toHaveLength(1);
    const printed = out.lines.join("\n");
    for (const secret of [CLIENT_SECRET, WEBHOOK_SECRET]) expect(printed).not.toContain(secret);
  });

  test("Vercel refusing the write prints its status and how to finish by hand", async () => {
    const net = fakeNetwork(
      world({ vercelPost: new Reply(400, { error: { message: `bad value ${PEM}` } }) }),
    );
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    expect(out.lines).toContain("fail    Vercel answered 400 for storing the App's variables");
    expect(out.lines).toContain(
      "The App ponzu exists, but its secrets are not all on ponzu-api-prod. To finish by hand:",
    );
    const printed = out.lines.join("\n");
    for (const secret of SECRETS) expect(printed).not.toContain(secret);
    // WorkOS still gets its secret, and the file is still deleted.
    expect(out.secretFiles.map((f) => f.text)).toEqual([CLIENT_SECRET]);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  test("Vercel taking the request but refusing a secret in it says how to finish by hand", async () => {
    const envs: Record<string, unknown>[] = [];
    const net = fakeNetwork(
      world({
        envs,
        vercelPost: (s: { body: Record<string, unknown>[] }) => {
          const created = s.body.filter((e) => e.key !== "GITHUB_APP_PRIVATE_KEY");
          for (const e of created) envs.push({ ...e, id: `env_${envs.length}`, value: "" });
          return new Reply(201, {
            created: created.map(({ value: _value, ...e }) => e),
            failed: [{ error: { code: "ENV_CONFLICT", key: "GITHUB_APP_PRIVATE_KEY" } }],
          });
        },
      }),
    );
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    expect(out.lines).toContain("fail    GITHUB_APP_PRIVATE_KEY is not on the Production target");
    expect(out.lines).toContain(
      "The App ponzu exists, but its secrets are not all on ponzu-api-prod. To finish by hand:",
    );
    const printed = out.lines.join("\n");
    for (const secret of SECRETS) expect(printed).not.toContain(secret);
  });

  test("a slug GitHub chose differently is stored as it is, and infra is named as behind", async () => {
    const net = fakeNetwork(
      world({ conversion: new Reply(201, conversion({ slug: "ponzu-cloud" })) }),
    );
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    const post = net.writes()[1]?.body as { key: string; value: string }[];
    expect(post.find((e) => e.key === "GITHUB_APP_SLUG")?.value).toBe("ponzu-cloud");
    expect(post.find((e) => e.key === "GITHUB_APP_BOT_USER_ID")?.value).toBe(String(BOT.id));
    expect(out.lines).toContain(
      'pending GitHub named the App "ponzu-cloud", not "ponzu": infra/environments.json\'s githubAppSlug and infra/github-app/ponzu.json must take the new slug (tell the orchestrator)',
    );
  });

  test("a bot user GitHub does not show yet is a fail line with the command to finish", async () => {
    const routes = world();
    delete routes["GET /users/ponzu%5Bbot%5D"];
    const net = fakeNetwork(routes);
    const out = io(net.fetch, { VERCEL_TOKEN: TOKEN }, founder());
    expect(await main(ARGS, out, infra)).toBe(1);
    await Promise.all(out.visits);
    expect(net.seen.filter((s) => s.url.endsWith("/users/ponzu%5Bbot%5D"))).toHaveLength(3);
    const post = net.writes()[1]?.body as { key: string }[];
    expect(post.map((e) => e.key)).not.toContain("GITHUB_APP_BOT_USER_ID");
    expect(out.lines.some((l) => l.startsWith("fail    GITHUB_APP_BOT_USER_ID: "))).toBe(true);
  });
});
