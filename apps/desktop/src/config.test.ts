import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aboutVersion,
  type BuildEnvironment,
  bakeEnvironment,
  bundleMismatch,
  claimsScheme,
  configFor,
  type EnvironmentsFile,
  environmentOverride,
} from "./config.ts";
import { contentSecurityPolicy } from "./csp.ts";
import {
  built,
  DEV_ENVIRONMENT,
  ENVIRONMENTS_FILE,
  environmentsFile,
  TEST_COMMIT,
} from "./testing.ts";

const release = configFor(true, {}, built());
const dev = configFor(true, {}, built({ variant: "dev" }));
const local = configFor(false, {}, built());

/** The repository's file with production filled in, as the cutover PR will have it. */
const FILLED = join(import.meta.dir, "../../../scripts/prod/fixtures/environments-filled.json");
const PRODUCTION = bakeEnvironment(environmentsFile(FILLED), "release");

test("a packaged app starts only when its bundle and its main process are the same app", () => {
  expect(bundleMismatch(true, "Ponzu", release)).toBeNull();
  expect(bundleMismatch(true, "Ponzu Dev", dev)).toBeNull();
  // A Ponzu Dev bundle holding a release's main process would take 1.x's folder and clean it up.
  expect(bundleMismatch(true, "Ponzu Dev", release)).toContain("Ponzu Dev");
  expect(bundleMismatch(true, "Ponzu", dev)).not.toBeNull();
  // Ponzu Local runs inside node_modules' Electron.app, named "Electron".
  expect(bundleMismatch(false, "Electron", local)).toBeNull();
});

test("the smoke check claims no link scheme, and Ponzu Local has none to claim", () => {
  for (const app of [release, dev, local]) expect(claimsScheme(app, true)).toBe(false);
  expect(claimsScheme(release, false)).toBe(true);
  expect(claimsScheme(dev, false)).toBe(true);
  expect(local.linkScheme).toBeNull();
  expect(claimsScheme(local, false)).toBe(false);
});

describe("the environment a build bakes", () => {
  test("a release bakes production and Ponzu Dev bakes dev, as infra/environments.json has it", () => {
    const file = JSON.parse(readFileSync(ENVIRONMENTS_FILE, "utf8"));
    expect(file.release).toBe("production");
    const production: BuildEnvironment = {
      name: "production",
      apiUrl: "https://api.ponzu.design",
      workosClientId: "client_01M72Y00V5GD7G4VZJR56D5JS7",
      realtimeUrl: "https://ep-sweet-wind-bcfbxi95.rt.c-16.us-east-1.aws.neon.tech",
      assetsUrl: "https://assets.ponzu.cloud",
    };
    const dev: BuildEnvironment = {
      name: "dev",
      apiUrl: "https://api-dev.ponzu.design",
      workosClientId: "client_01M72Y00K1VV63G6V5D25YCE6K",
      realtimeUrl: "https://ep-quiet-butterfly-bc2zsmia.rt.c-16.us-east-1.aws.neon.tech",
      assetsUrl: "https://assets-dev.ponzu.cloud",
    };
    expect(bakeEnvironment(file, "release")).toEqual(production);
    expect(bakeEnvironment(file, "dev")).toEqual(dev);
    expect(DEV_ENVIRONMENT).toEqual(dev);
  });

  test("once release names production, a release bakes production and Ponzu Dev stays on dev", () => {
    const file = environmentsFile(FILLED);
    expect(bakeEnvironment(file, "release")).toEqual({
      name: "production",
      apiUrl: "https://api.ponzu.design",
      workosClientId: "client_01AAAAAAAAAAAAAAAAAAAAAAAA",
      realtimeUrl: "https://ep-example-000000.rt.c-16.us-east-1.aws.neon.tech",
      assetsUrl: "https://assets.ponzu.cloud",
    });
    expect(bakeEnvironment(file, "dev")).toMatchObject({
      name: "dev",
      apiUrl: "https://api-dev.ponzu.design",
      assetsUrl: "https://assets-dev.ponzu.cloud",
    });
  });

  test("a release build refuses a null field, naming each; a dev build of the same file doesn't", () => {
    // The repository's file, as it was before production's sign-in and Realtime existed.
    const file = environmentsFile();
    const early: EnvironmentsFile = {
      ...file,
      release: "production",
      environments: {
        ...file.environments,
        production: {
          ...(file.environments.production as EnvironmentsFile["environments"][string]),
          workosClientId: null,
          realtimeUrl: null,
        },
      },
    };
    expect(() => bakeEnvironment(early, "release")).toThrow(
      [
        "production.workosClientId is not set in infra/environments.json",
        "production.realtimeUrl is not set in infra/environments.json",
      ].join("\n"),
    );
    expect(bakeEnvironment(early, "dev").name).toBe("dev");
    // Dev's own null fails Ponzu Dev and a release on dev alike.
    const devless: EnvironmentsFile = {
      ...file,
      release: "dev",
      environments: {
        ...file.environments,
        dev: {
          ...(file.environments.dev as EnvironmentsFile["environments"][string]),
          assetsUrl: null,
        },
      },
    };
    for (const variant of ["release", "dev"] as const) {
      expect(() => bakeEnvironment(devless, variant)).toThrow(
        "dev.assetsUrl is not set in infra/environments.json",
      );
    }
    expect(() => bakeEnvironment({ ...file, release: "staging" }, "release")).toThrow(
      'infra/environments.json has no environment "staging"',
    );
  });

  test("an app that was baked no environment refuses to start", () => {
    expect(() => configFor(true, {}, built({ environment: null }))).toThrow(
      "This build has no environment",
    );
    expect(() => configFor(false, {}, built({ environment: null }))).toThrow(
      "This build has no environment",
    );
  });

  test("each variant talks to the environment it was built for, whatever its environment says", () => {
    const env = {
      PONZU_API_URL: "https://evil.example",
      PONZU_WORKOS_CLIENT_ID: "client_evil",
      PONZU_ENVIRONMENT_OVERRIDE: JSON.stringify({ ...PRODUCTION, apiUrl: "https://evil.example" }),
    };
    for (const variant of ["release", "dev"] as const) {
      for (const environment of [DEV_ENVIRONMENT, PRODUCTION]) {
        expect(configFor(true, env, built({ variant, environment }))).toMatchObject({
          environment: environment.name,
          commit: TEST_COMMIT,
          apiUrl: environment.apiUrl,
          workosClientId: environment.workosClientId,
          realtimeUrl: environment.realtimeUrl,
          assetsUrl: environment.assetsUrl,
        });
      }
    }
  });

  test("Ponzu Local starts from the baked environment, and says custom once pointed elsewhere", () => {
    expect(local).toMatchObject({
      environment: "dev",
      apiUrl: DEV_ENVIRONMENT.apiUrl,
      workosClientId: DEV_ENVIRONMENT.workosClientId,
      realtimeUrl: null,
      assetsUrl: null,
    });
    const elsewhere = configFor(false, { PONZU_API_URL: "http://localhost:8787" }, built());
    expect(elsewhere).toMatchObject({ environment: "custom", apiUrl: "http://localhost:8787" });
    const signIn = configFor(false, { PONZU_WORKOS_CLIENT_ID: "client_mine" }, built());
    expect(signIn).toMatchObject({ environment: "custom", workosClientId: "client_mine" });
    // It never reads the test build's override: it has variables of its own.
    const override = JSON.stringify({ ...PRODUCTION, name: "elsewhere" });
    expect(configFor(false, { PONZU_ENVIRONMENT_OVERRIDE: override }, built()).environment).toBe(
      "dev",
    );
  });
});

describe("PONZU_ENVIRONMENT_OVERRIDE", () => {
  const stack: BuildEnvironment = {
    name: "e2e",
    apiUrl: "http://127.0.0.1:8787",
    workosClientId: "client_test",
    realtimeUrl: "http://localhost:4444",
    assetsUrl: "https://assets.test",
  };
  const env = { PONZU_ENVIRONMENT_OVERRIDE: JSON.stringify(stack) };

  test("a test build honours it, whole", () => {
    expect(configFor(true, env, built({ test: true }))).toMatchObject({
      environment: "e2e",
      apiUrl: "http://127.0.0.1:8787",
      workosClientId: "client_test",
      realtimeUrl: "http://localhost:4444",
      assetsUrl: "https://assets.test",
    });
    // Unset, a test build is the baked one.
    expect(configFor(true, {}, built({ test: true })).environment).toBe("dev");
  });

  test("a release and Ponzu Dev ignore it", () => {
    for (const variant of ["release", "dev"] as const) {
      expect(configFor(true, env, built({ variant }))).toMatchObject({
        environment: "dev",
        apiUrl: DEV_ENVIRONMENT.apiUrl,
      });
    }
    // Even one that doesn't parse: a release never reads it, so it can never stop one.
    expect(configFor(true, { PONZU_ENVIRONMENT_OVERRIDE: "{" }, built()).environment).toBe("dev");
  });

  test("one a test build can't use stops it, rather than falling back to the baked one", () => {
    expect(() => environmentOverride({ PONZU_ENVIRONMENT_OVERRIDE: "{" })).toThrow("not JSON");
    expect(() =>
      environmentOverride({
        PONZU_ENVIRONMENT_OVERRIDE: JSON.stringify({ ...stack, apiUrl: "http://api.example" }),
      }),
    ).toThrow("PONZU_ENVIRONMENT_OVERRIDE has no usable apiUrl.");
    expect(() =>
      environmentOverride({ PONZU_ENVIRONMENT_OVERRIDE: JSON.stringify({ apiUrl: stack.apiUrl }) }),
    ).toThrow(
      "PONZU_ENVIRONMENT_OVERRIDE has no usable name, workosClientId, realtimeUrl, assetsUrl.",
    );
    expect(() =>
      configFor(true, { PONZU_ENVIRONMENT_OVERRIDE: "null" }, built({ test: true })),
    ).toThrow("PONZU_ENVIRONMENT_OVERRIDE has no usable");
    expect(environmentOverride({})).toBeNull();
  });
});

function directives(config: Parameters<typeof contentSecurityPolicy>[0]): Record<string, string[]> {
  return Object.fromEntries(
    contentSecurityPolicy(config)
      .split("; ")
      .map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
  );
}

test("the policy names exactly its environment's hosts, and none of the other's", () => {
  const fonts = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
  const expected: Record<string, { connect: string[]; assets: string }> = {
    dev: {
      connect: [
        "'self'",
        "https://api-dev.ponzu.design",
        "https://ep-quiet-butterfly-bc2zsmia.rt.c-16.us-east-1.aws.neon.tech",
        "wss://ep-quiet-butterfly-bc2zsmia.rt.c-16.us-east-1.aws.neon.tech",
        "https://assets-dev.ponzu.cloud",
        ...fonts,
      ],
      assets: "https://assets-dev.ponzu.cloud",
    },
    production: {
      connect: [
        "'self'",
        "https://api.ponzu.design",
        "https://ep-example-000000.rt.c-16.us-east-1.aws.neon.tech",
        "wss://ep-example-000000.rt.c-16.us-east-1.aws.neon.tech",
        "https://assets.ponzu.cloud",
        ...fonts,
      ],
      assets: "https://assets.ponzu.cloud",
    },
  };
  for (const environment of [DEV_ENVIRONMENT, PRODUCTION]) {
    const want = expected[environment.name]!;
    for (const variant of ["release", "dev"] as const) {
      const policy = directives(configFor(true, {}, built({ variant, environment })));
      expect(policy["connect-src"]).toEqual(want.connect);
      expect(policy["media-src"]).toEqual(["'self'", "blob:", want.assets]);
      expect(policy["font-src"]).toEqual([
        "'self'",
        "data:",
        "https://fonts.gstatic.com",
        want.assets,
      ]);
    }
  }
});

test("About says the commit and the environment", () => {
  expect(aboutVersion(release)).toBe("0123456 · dev");
  expect(aboutVersion(configFor(true, {}, built({ environment: PRODUCTION })))).toBe(
    "0123456 · production",
  );
  expect(aboutVersion({ commit: "unknown", environment: "custom" })).toBe("unknown · custom");
  // Anything else baked as a commit shows as unknown, never as it came.
  expect(aboutVersion({ commit: "<script>", environment: "dev" })).toBe("unknown · dev");
});

/**
 * scripts/build.ts's environment step, alone and in its own process, against `file`: it reads
 * the file through desired.ts's schema, then bakes. The build itself (which empties dist/) runs
 * in CI's Desktop package job.
 */
function bake(file: object, variant: "release" | "dev") {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-bake-"));
  try {
    const path = join(dir, "environments.json");
    writeFileSync(path, JSON.stringify(file));
    const desired = JSON.stringify(join(import.meta.dir, "../../../scripts/prod/desired.ts"));
    const config = JSON.stringify(join(import.meta.dir, "config.ts"));
    const script = join(dir, "bake.ts");
    writeFileSync(
      script,
      [
        `import { loadEnvironments } from ${desired};`,
        `import { bakeEnvironment } from ${config};`,
        "try {",
        "  const [file, variant] = process.argv.slice(2);",
        "  console.log(JSON.stringify(bakeEnvironment(loadEnvironments(file), variant)));",
        "} catch (error) {",
        "  console.error(error.message);",
        "  process.exit(1);",
        "}",
      ].join("\n"),
    );
    return spawnSync(process.execPath, [script, path, variant], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the build reads infra/environments.json through desired.ts's schema, so a bad file fails", () => {
  const file = JSON.parse(readFileSync(ENVIRONMENTS_FILE, "utf8"));
  const ok = bake(file, "release");
  expect(ok.status).toBe(0);
  expect(JSON.parse(ok.stdout)).toMatchObject({
    name: "production",
    apiUrl: "https://api.ponzu.design",
    workosClientId: "client_01M72Y00V5GD7G4VZJR56D5JS7",
  });
  expect(JSON.parse(bake(file, "dev").stdout)).toEqual(DEV_ENVIRONMENT);
  const unset = structuredClone(file);
  unset.environments.production.workosClientId = null;
  const refusedRelease = bake(unset, "release");
  expect(refusedRelease.status).toBe(1);
  expect(refusedRelease.stderr).toContain(
    "production.workosClientId is not set in infra/environments.json",
  );
  expect(bake(unset, "dev").status).toBe(0);
  // Not an https origin: the schema refuses it before anything is baked.
  const broken = structuredClone(file);
  broken.environments.dev.apiUrl = "http://api.ponzu.design";
  const refused = bake(broken, "dev");
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("environments.dev.apiUrl");
});
