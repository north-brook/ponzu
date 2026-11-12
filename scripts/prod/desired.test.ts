import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Environments,
  EnvironmentsSchema,
  FirewallSchema,
  fieldLines,
  INFRA_DIR,
  INFRA_FILES,
  LifecycleSchema,
  listJson,
  loadEnvironments,
  loadInfra,
  loadInfraFile,
  main,
  NeonSchema,
  RULESET_REQUEST_FIELDS,
  RulesetSchema,
  releaseProblems,
} from "./desired";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = join(import.meta.dir, "fixtures");
const FILLED = join(FIXTURES, "environments-filled.json");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function run(...argv: string[]) {
  const lines: string[] = [];
  const code = main(argv, (line) => lines.push(line));
  return { code, lines };
}

describe("infra/", () => {
  test("every file parses with its schema, and every file has one", () => {
    expect(listJson(INFRA_DIR)).toEqual(Object.keys(INFRA_FILES).sort());
    expect(() => loadInfra()).not.toThrow();
  });

  test("dev's values are the ones apps/desktop/src/config.ts hard-codes today", () => {
    // Removed by production slice 3, when the desktop build reads infra/environments.json.
    const source = readFileSync(join(ROOT, "apps/desktop/src/config.ts"), "utf8");
    const constant = (name: string) => {
      const match = source.match(new RegExp(`^const ${name} = "([^"]+)";$`, "m"));
      if (!match?.[1]) throw new Error(`config.ts has no ${name}`);
      return match[1];
    };
    const dev = loadEnvironments().environments.dev;
    expect(dev.apiUrl).toBe(constant("API_URL"));
    expect(dev.workosClientId).toBe(constant("WORKOS_CLIENT_ID"));
    expect(dev.realtimeUrl).toBe(constant("REALTIME_URL"));
    expect(dev.assetsUrl).toBe(constant("ASSETS_URL"));
  });

  test("the release build stays on dev until the cutover PR flips it", () => {
    expect(loadEnvironments().release).toBe("dev");
  });
});

describe("assert-release", () => {
  test("production exits 1 while production has nulls, naming each one", () => {
    const { code, lines } = run("assert-release", "production");
    expect(code).toBe(1);
    expect(lines).toEqual([
      'fail    release is "dev" in infra/environments.json, not "production"',
      "fail    production.workosClientId is not set in infra/environments.json (founder step D7)",
      "fail    production.realtimeUrl is not set in infra/environments.json (founder step D3)",
      "fail    production.posthog.projectId is not set in infra/environments.json (founder step D8)",
      "fail    production.apiUrl is the same as dev's, so a release would reach dev",
      "fail    api.ponzu.design is in both environments' apiDomains; move dev's first",
    ]);
  });

  test("a production field copied from dev fails, so a release never reaches dev", () => {
    const shared = {
      apiUrl: "https://api-dev.ponzu.design",
      workosClientId: "client_01M72Y00K1VV63G6V5D25YCE6K",
      realtimeUrl: "https://ep-quiet-butterfly-bc2zsmia.rt.c-16.us-east-1.aws.neon.tech",
      assetsUrl: "https://assets-dev.ponzu.cloud",
      githubAppSlug: "ponzu-dev",
      vercelProject: "ponzu-api",
      neonBranch: "dev",
      "r2.assets": "example-dev-assets",
      "posthog.projectId": 728454,
    } as const;
    for (const [path, value] of Object.entries(shared)) {
      const file = read(FILLED);
      const keys = path.split(".");
      const last = keys.pop() as string;
      const parent = keys.reduce((o, k) => o[k], file.environments.production);
      parent[last] = value;
      if (path === "apiUrl") file.environments.production.apiDomains = ["api-dev.ponzu.design"];
      const problems = releaseProblems(EnvironmentsSchema.parse(file), "production");
      expect(problems).toContain(
        `production.${path} is the same as dev's, so a release would reach dev`,
      );
    }
  });

  test("production may not go without a private bucket", () => {
    const file = read(FILLED);
    file.environments.production.r2.private = false;
    expect(EnvironmentsSchema.safeParse(file).success).toBe(false);
  });

  test("production exits 0 on a filled file", () => {
    const { code, lines } = run("assert-release", "production", "--file", FILLED);
    expect(code).toBe(0);
    expect(lines).toEqual([
      "ok      the release build talks to production, and every field is set",
    ]);
  });

  test("one null left in a filled file is enough to fail", () => {
    const file = loadEnvironments(FILLED);
    file.environments.production.realtimeUrl = null;
    expect(releaseProblems(file, "production")).toEqual([
      "production.realtimeUrl is not set in infra/environments.json (founder step D3)",
    ]);
  });

  test("a filled production with release still on dev fails on that alone", () => {
    const file: Environments = { ...loadEnvironments(FILLED), release: "dev" };
    expect(releaseProblems(file, "production")).toEqual([
      'release is "dev" in infra/environments.json, not "production"',
    ]);
  });

  test("the command line runs as a script and exits 1 on today's file", async () => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "desired.ts"), "assert-release", "production"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toContain("fail    production.workosClientId");
  });

  test("a bad command or environment is a usage error, exit 2", () => {
    expect(run("assert-release", "staging").code).toBe(2);
    expect(run("deploy", "production").code).toBe(2);
    expect(run("assert-release", "production", "--file").code).toBe(2);
    expect(run("assert-release", "production", "--force").code).toBe(2);
  });
});

describe("status", () => {
  test("a production null prints as pending, never as ok", () => {
    const { code, lines } = run("status", "production");
    expect(code).toBe(0);
    const pending = lines.filter((line) => line.startsWith("pending "));
    expect(pending).toEqual([
      "pending production.workosClientId: founder step D7",
      "pending production.realtimeUrl: founder step D3",
      "pending production.posthog.projectId: founder step D8",
    ]);
    for (const path of ["workosClientId", "realtimeUrl", "posthog.projectId"]) {
      expect(lines.some((l) => l.startsWith("ok") && l.includes(`production.${path}:`))).toBe(
        false,
      );
    }
  });

  test("every null anywhere is pending, including ones nobody named", () => {
    const file = loadEnvironments(FILLED);
    file.environments.production.githubAppSlug = null;
    const line = fieldLines(file, "production").find((l) => l.path === "production.githubAppSlug");
    expect(line).toEqual({
      path: "production.githubAppSlug",
      state: "pending",
      says: "not created yet",
    });
  });

  test("an absent-on-purpose false is none, and aiContent false is a value", () => {
    const lines = fieldLines(loadEnvironments(), "dev");
    expect(lines.find((l) => l.path === "dev.r2.private")?.state).toBe("none");
    expect(lines.find((l) => l.path === "dev.minClientVersions")?.state).toBe("none");
    expect(lines.find((l) => l.path === "dev.r2.assets")).toEqual({
      path: "dev.r2.assets",
      state: "pending",
      says: "read from Cloudflare by production slice 9",
    });
    const prod = fieldLines(loadEnvironments(), "production");
    expect(prod.find((l) => l.path === "production.posthog.aiContent")).toEqual({
      path: "production.posthog.aiContent",
      state: "ok",
      says: "false",
    });
  });
});

describe("environments.json's schema", () => {
  test("refuses a trailing slash, http, an unknown field and an apiUrl off its domains", () => {
    const cases: ((file: ReturnType<typeof read>) => void)[] = [
      (f) => {
        f.environments.dev.apiUrl = "https://api.ponzu.design/";
      },
      (f) => {
        f.environments.dev.assetsUrl = "http://assets-dev.ponzu.cloud";
      },
      (f) => {
        f.environments.dev.extra = 1;
      },
      (f) => {
        f.environments.production.apiDomains = ["api-dev.ponzu.design"];
      },
      (f) => {
        f.release = "staging";
      },
      (f) => {
        f.environments.dev.minClientVersions = "macos=2";
      },
      (f) => {
        f.environments.production.workosClientId = "";
      },
    ];
    for (const mutate of cases) {
      const file = read(join(INFRA_DIR, "environments.json"));
      mutate(file);
      expect(EnvironmentsSchema.safeParse(file).success).toBe(false);
    }
    expect(EnvironmentsSchema.safeParse(read(join(INFRA_DIR, "environments.json"))).success).toBe(
      true,
    );
  });
});

describe("vercel-firewall.json", () => {
  const firewall = () => read(join(INFRA_DIR, "vercel-firewall.json"));

  test("xss and sqli only ever log", () => {
    for (const category of ["xss", "sqli"]) {
      const fw = firewall();
      fw.crs[category].action = "deny";
      expect(FirewallSchema.safeParse(fw).success).toBe(false);
    }
  });

  test("no rule challenges, and a rate limit needs its numbers", () => {
    const challenge = firewall();
    challenge.rules[0].action.mitigate.action = "challenge";
    expect(FirewallSchema.safeParse(challenge).success).toBe(false);
    const bare = firewall();
    delete bare.rules[1].action.mitigate.rateLimit;
    expect(FirewallSchema.safeParse(bare).success).toBe(false);
  });

  test("the per-IP limits are the design's numbers", () => {
    const fw = loadInfraFile("vercel-firewall.json");
    const limits = Object.fromEntries(
      fw.rules
        .filter((r) => r.action.mitigate.rateLimit)
        .map((r) => {
          const rl = r.action.mitigate.rateLimit as { window: number; limit: number; algo: string };
          return [r.name, `${rl.limit}/${rl.window}s ${rl.algo}`];
        }),
    );
    expect(limits).toEqual({
      "sign-in exchange per ip": "20/60s fixed_window",
      "github setup per ip": "30/60s fixed_window",
      "claude sign-ins per ip": "20/3600s fixed_window",
      "api per ip": "1200/60s token_bucket",
    });
    expect(fw.rules[0]?.action.mitigate.action).toBe("deny");
    expect(fw.managedRules.bot_protection.action).toBe("log");
  });
});

describe("neon.json and r2/lifecycle.json", () => {
  test("production never scales to zero", () => {
    const neon = read(join(INFRA_DIR, "neon.json"));
    neon.environments.production.compute.suspendTimeoutSeconds = 300;
    expect(NeonSchema.safeParse(neon).success).toBe(false);
  });

  test("no lifecycle rule touches private/, and no delete rule lacks a prefix", () => {
    const lifecycle = () => read(join(INFRA_DIR, "r2/lifecycle.json"));
    const onPrivate = lifecycle();
    onPrivate.rules[0].conditions.prefix = "private/";
    expect(LifecycleSchema.safeParse(onPrivate).success).toBe(false);
    const everything = lifecycle();
    everything.rules[0].conditions.prefix = "";
    expect(LifecycleSchema.safeParse(everything).success).toBe(false);
    // A delete on a short prefix reaches private/ just the same.
    for (const prefix of ["p", "priv", "private"]) {
      const short = lifecycle();
      short.rules[0].conditions.prefix = prefix;
      expect(LifecycleSchema.safeParse(short).success).toBe(false);
    }
    // Aborting unfinished uploads everywhere deletes no finished object, so it stays allowed.
    expect(lifecycle().rules[1].conditions.prefix).toBe("");
    expect(LifecycleSchema.safeParse(lifecycle()).success).toBe(true);
  });
});

describe("github/", () => {
  // Recorded read-only with `gh api repos/north-brook/ponzu/rulesets/25478973`.
  const recorded = read(join(FIXTURES, "github/ruleset-25478973.json"));
  const READ_ONLY = [
    "id",
    "source_type",
    "source",
    "node_id",
    "_links",
    "created_at",
    "updated_at",
    "current_user_can_bypass",
  ];

  test("the recorded ruleset has only the fields the API takes, plus read-only ones", () => {
    const keys = Object.keys(recorded).filter((key) => !READ_ONLY.includes(key));
    expect(keys.sort()).toEqual([...RULESET_REQUEST_FIELDS].sort());
    const request = Object.fromEntries(RULESET_REQUEST_FIELDS.map((k) => [k, recorded[k]]));
    expect(RulesetSchema.safeParse(request).success).toBe(true);
  });

  test("main's ruleset is main's today, unchanged", () => {
    const request = Object.fromEntries(RULESET_REQUEST_FIELDS.map((k) => [k, recorded[k]]));
    expect(loadInfraFile("github/ruleset-main.json") as unknown).toEqual(request);
  });

  test("a field the API doesn't take is refused", () => {
    const withId = { ...loadInfraFile("github/ruleset-cloud.json"), id: 1 };
    expect(RulesetSchema.safeParse(withId).success).toBe(false);
  });

  test("cloud requires the four checks, each a job name in ci.yml", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const jobNames = [...ci.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1]?.trim());
    const cloud = loadInfraFile("github/ruleset-cloud.json");
    expect(cloud.conditions.ref_name.include).toEqual(["refs/heads/cloud"]);
    const checks = cloud.rules.find((r) => r.type === "required_status_checks")?.parameters as {
      required_status_checks: { context: string }[];
    };
    const contexts = checks.required_status_checks.map((c) => c.context);
    expect(contexts).toEqual([
      "Conventional commit messages",
      "Check, typecheck, test",
      "Database on Postgres",
      "Desktop package",
    ]);
    for (const context of contexts) expect(jobNames).toContain(context);
  });

  test("the repository's merge settings are today's", () => {
    // Recorded read-only with `gh api repos/north-brook/ponzu`.
    expect(loadInfraFile("github/repo.json").merge).toEqual(
      read(join(FIXTURES, "github/repo.json")),
    );
  });

  test("every variable and secret a workflow reads is named in repo.json", () => {
    const repo = loadInfraFile("github/repo.json");
    const named = new Set([
      ...repo.variables,
      ...repo.secrets,
      ...Object.values(repo.environments).flatMap((e) => e.secrets),
    ]);
    const dir = join(ROOT, ".github/workflows");
    const used = new Set<string>();
    for (const name of listFiles(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      for (const m of text.matchAll(/\b(?:vars|secrets)\.([A-Z][A-Z0-9_]*)/g))
        used.add(m[1] as string);
    }
    // 1.x's npm job reads PONZU_POSTHOG_KEY; it is deleted with the local runtime (G1).
    used.delete("PONZU_POSTHOG_KEY");
    expect([...used].filter((name) => !named.has(name)).sort()).toEqual([]);
  });
});

function listFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".yml"));
}
