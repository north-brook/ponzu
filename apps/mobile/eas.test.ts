import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { configFor, pushMode, VARIANTS, variantOf } from "./app.config";

interface Profile {
  bun?: string;
  channel?: string;
  developmentClient?: boolean;
  distribution?: string;
  environment?: string;
  autoIncrement?: boolean;
  env?: Record<string, string>;
  extends?: string;
  ios?: { simulator?: boolean; distribution?: string; env?: Record<string, string> };
}

interface Job {
  type?: string;
  if?: string;
  needs?: string[];
  environment?: string;
  env?: Record<string, string>;
  params: Record<string, unknown>;
  outputs?: Record<string, string>;
  steps?: { id?: string; run?: string }[];
}

interface Workflow {
  on: {
    push?: { branches?: string[]; tags?: string[]; paths?: string[] };
    workflow_dispatch?: unknown;
    pull_request?: unknown;
    schedule?: unknown;
  };
  jobs: Record<string, Job>;
}

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const { build } = JSON.parse(read("./eas.json")) as { build: Record<string, Profile> };
const workflow = (name: string) => YAML.parse(read(`./.eas/workflows/${name}`)) as Workflow;
const WORKFLOWS = ["preview.yml", "production.yml", "shared.yml"];

function resolved(name: string, seen = new Set<string>()): Profile {
  if (seen.has(name)) throw new Error(`Cyclic build profile: ${name}`);
  seen.add(name);
  const profile = build[name];
  if (!profile) throw new Error(`Missing build profile: ${name}`);
  const parent = profile.extends ? resolved(profile.extends, seen) : {};
  return {
    ...parent,
    ...profile,
    env: { ...parent.env, ...profile.env },
    ios: { ...parent.ios, ...profile.ios, env: { ...parent.ios?.env, ...profile.ios?.env } },
  };
}

// EAS images ship their own Bun, which writes a different bun.lock than the
// pinned one: the frozen install fails and nothing reaches testers. Every
// build profile and every workflow's installs use the pin.
describe("EAS installs with the pinned Bun", () => {
  const manifest = JSON.parse(read("../../package.json")) as { packageManager: string };
  const pinned = manifest.packageManager.replace(/^bun@/, "");
  for (const name of Object.keys(build)) {
    test(`build profile ${name}`, () => expect(resolved(name).bun).toBe(pinned));
  }
  for (const name of WORKFLOWS) {
    test(`workflow ${name}`, () => {
      expect(read(`./.eas/workflows/${name}`)).toMatch(
        new RegExp(`defaults:\\s+tools:\\s+bun: ${pinned.replaceAll(".", "\\.")}\\n`),
      );
    });
  }
});

// What goes to TestFlight is what testers run: no dev client, no simulator
// binary, no test switches, and a build number EAS raises every time.
test("store builds are plain release builds of the production app", () => {
  const profile = resolved("production");
  expect(profile.developmentClient).toBeFalsy();
  expect(profile.ios?.simulator).toBeFalsy();
  expect(profile.ios?.distribution ?? profile.distribution ?? "store").toBe("store");
  expect(profile.autoIncrement).toBe(true);
  expect(profile.channel).toBe("production");
  const env = { ...profile.env, ...profile.ios?.env };
  expect(Object.keys(env).filter((key) => /TEST/.test(key))).toEqual([]);
  // Never Ponzu Dev, and never the fake backend.
  expect(variantOf(env)).toBe("production");
  expect(env.PONZU_BACKEND).toBeUndefined();
});

// One lane: every TestFlight build is a production build and every phone listens on
// `production`. A second store lane shares TestFlight's build numbers, so a phone gets
// whichever lane built last, and with it that lane's channel.
test("production is the only store build, and only production.yml builds on a push", () => {
  // `base` is only what the others extend: it's never built.
  const store = Object.keys(build).filter((name) => {
    const profile = resolved(name);
    return (
      name !== "base" &&
      !profile.developmentClient &&
      !profile.ios?.simulator &&
      (profile.ios?.distribution ?? profile.distribution ?? "store") === "store"
    );
  });
  expect(store).toEqual(["production"]);
  expect(readdirSync(join(import.meta.dir, ".eas/workflows")).sort()).toEqual(WORKFLOWS);
  const builds = Object.values(workflow("shared.yml").jobs).filter((job) =>
    ["build", "submit", "testflight"].includes(job.type ?? ""),
  );
  expect(builds).toEqual([]);
});

// Ponzu Dev, the cloud app before cutover: a different bundle id and scheme, so nothing of it
// reaches a phone running the 1.x app, or TestFlight.
describe("Ponzu Dev builds", () => {
  test("the development client and the preview builds are Ponzu Dev, never the fake", () => {
    for (const name of ["development", "preview"]) {
      const env = resolved(name).env ?? {};
      expect(variantOf(env)).toBe("dev");
      expect(env.PONZU_BACKEND).toBeUndefined();
    }
  });

  test("a preview build is internal, on its own channel and environment", () => {
    const preview = resolved("preview");
    expect(preview.distribution).toBe("internal");
    expect(preview.developmentClient).toBeFalsy();
    expect(preview.channel).toBe("preview");
    expect(preview.environment).toBe("preview");
    expect(preview.autoIncrement).toBeFalsy();
  });

  test("preview.yml runs only by hand: agents never deploy, so nothing starts it on a push", () => {
    const { on } = workflow("preview.yml");
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
  });

  test("preview.yml: a new fingerprint builds Ponzu Dev, an old one updates on preview", () => {
    const { jobs } = workflow("preview.yml");
    const { fingerprint, ios_build_exists: lookup, build_ios: binary, update_ios: update } = jobs;
    expect(Object.keys(jobs).sort()).toEqual([
      "build_ios",
      "fingerprint",
      "ios_build_exists",
      "update_ios",
    ]);
    // The fingerprint and the update read the config as Ponzu Dev's, as the build does.
    expect(fingerprint?.environment).toBe("preview");
    expect(fingerprint?.env).toEqual({ APP_VARIANT: "dev" });
    expect(lookup?.type).toBe("get-build");
    expect(lookup?.params).toMatchObject({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
      fingerprint_hash: "${{ needs.fingerprint.outputs.ios_fingerprint_hash }}",
      profile: "preview",
    });
    expect(binary?.type).toBe("build");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
    expect(binary?.if).toBe("${{ !needs.ios_build_exists.outputs.build_id }}");
    expect(binary?.params).toEqual({ platform: "ios", profile: "preview" });
    expect(update?.type).toBe("update");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
    expect(update?.if).toBe("${{ needs.ios_build_exists.outputs.build_id }}");
    expect(update?.environment).toBe("preview");
    expect(update?.env).toEqual({ APP_VARIANT: "dev" });
    expect(update?.params).toEqual({ channel: resolved("preview").channel, platform: "ios" });
    const types = Object.values(jobs).map((job) => job.type);
    expect(types).not.toContain("testflight");
    expect(types).not.toContain("submit");
  });
});

// A release builds a binary only when native code changed (a new
// fingerprint); every other release ships over the air on its channel.
test("production.yml: a new fingerprint builds, an old one updates over the air", () => {
  const profile = "production";
  const { jobs } = workflow("production.yml");
  const { ios_build_exists: lookup, build_ios: binary, update_ios: update } = jobs;
  expect(lookup?.type).toBe("get-build");
  expect(lookup?.params).toMatchObject({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
    fingerprint_hash: "${{ needs.fingerprint.outputs.ios_fingerprint_hash }}",
    profile,
  });
  expect(binary?.type).toBe("build");
  expect(binary?.needs).toEqual(["ios_build_exists"]);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
  expect(binary?.if).toBe("${{ !needs.ios_build_exists.outputs.build_id }}");
  expect(binary?.params).toMatchObject({ platform: "ios", profile });
  expect(update?.type).toBe("update");
  expect(update?.needs).toEqual(["ios_build_exists"]);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
  expect(update?.if).toBe("${{ needs.ios_build_exists.outputs.build_id }}");
  expect(update?.environment).toBe(profile);
  // Published to the channel the profile's builds listen on: a branch alone reaches only the
  // phones whose channel happens to point at it.
  expect(update?.params).toMatchObject({ channel: resolved(profile).channel, platform: "ios" });
  expect(update?.params.branch).toBeUndefined();
});

test("production runs on a mobile tag and sends a new binary to the Alpha group", () => {
  const { on, jobs } = workflow("production.yml");
  expect(on.push?.tags).toEqual(["mobile-v*"]);
  const submission = jobs.submit_ios;
  expect(submission?.type).toBe("testflight");
  expect(submission?.needs).toEqual(["build_ios", "notes"]);
  expect(submission?.params).toMatchObject({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
    build_id: "${{ needs.build_ios.outputs.build_id }}",
    external_groups: ["Alpha"],
    submit_beta_review: true,
  });
});

test("a new binary's What to Test is its release's notes, or a generic line", () => {
  const { jobs } = workflow("production.yml");
  const notes = jobs.notes;
  // Only a release that builds reaches TestFlight, so only it reads notes.
  expect(notes?.if).toBe(jobs.build_ios?.if);
  const run = notes?.steps?.map((step) => step.run ?? "").join("\n") ?? "";
  expect(run).toContain("--unshallow");
  expect(run).toContain('bun scripts/release-notes.ts --phone "$TAG"');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
  expect(notes?.outputs?.changelog).toBe("${{ steps.notes.outputs.changelog }}");
  expect(jobs.submit_ios?.params.changelog).toBe(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
    "${{ needs.notes.outputs.changelog || 'Bug fixes and improvements.' }}",
  );
});

// The phone bundles code from outside apps/mobile, which Release Please doesn't see: a change
// there goes out over the air on the production channel as it merges.
test("shared code the phone bundles goes out over the air on production", () => {
  const { on, jobs } = workflow("shared.yml");
  expect(on.push?.branches).toEqual(["main"]);
  expect(on.push?.tags).toBeUndefined();
  // The canvas and icons import packages/canvas's and packages/render's source by path, and
  // the app runs @ponzu/client.
  expect(on.push?.paths).toEqual([
    "packages/core/**",
    "packages/client/**",
    "packages/canvas/**",
    "packages/render/**",
    "patches/**",
    "bun.lock",
  ]);
  expect(Object.keys(jobs)).toEqual(["update_ios"]);
  expect(jobs.update_ios?.type).toBe("update");
  expect(jobs.update_ios?.environment).toBe("production");
  expect(jobs.update_ios?.params).toMatchObject({
    channel: resolved("production").channel,
    platform: "ios",
  });
  expect(jobs.update_ios?.params.branch).toBeUndefined();
});

describe("app.json", () => {
  const { expo } = JSON.parse(read("./app.json")) as {
    expo: {
      ios: { bundleIdentifier: string; infoPlist: Record<string, any> };
      runtimeVersion: { policy: string };
      extra: { eas: { projectId: string } };
      updates: { url: string };
      plugins: unknown[];
    };
  };
  const names = expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
  const options = (name: string) =>
    (expo.plugins.find((p) => Array.isArray(p) && p[0] === name) as [string, any])[1];

  test("an update reaches only binaries with the same native code", () => {
    expect(expo.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(expo.updates.url).toBe(`https://u.expo.dev/${expo.extra.eas.projectId}`);
  });

  test("the production app shares the Mac app's bundle id", () => {
    expect(expo.ios.bundleIdentifier).toBe("design.ponzu.app");
  });

  test("no ATS exception and no Bonjour: everything goes over https to Ponzu Cloud", () => {
    const plist = expo.ios.infoPlist;
    expect(plist.NSAppTransportSecurity).toBeUndefined();
    expect(plist.NSBonjourServices).toBeUndefined();
    expect(plist.NSLocalNetworkUsageDescription).toBeUndefined();
  });

  test("no camera: pairing by its code is gone", () => {
    expect(names).not.toContain("expo-camera");
    expect(expo.ios.infoPlist.NSCameraUsageDescription).toBeUndefined();
    expect(options("expo-image-picker").cameraPermission).toBe(false);
  });

  test("the native batch's modules are configured", () => {
    for (const name of ["expo-secure-store", "expo-web-browser", "expo-image-picker"]) {
      expect(names).toContain(name);
    }
    // The Keychain is read without Face ID.
    expect(options("expo-secure-store").faceIDPermission).toBe(false);
  });

  test("every permission says why", () => {
    expect(options("expo-speech-recognition").speechRecognitionPermission).toBeString();
    expect(options("expo-speech-recognition").microphonePermission).toBeString();
    expect(options("expo-image-picker").photosPermission).toBeString();
    // The picker names the same microphone reason as dictation, whichever plugin runs last.
    expect(options("expo-image-picker").microphonePermission).toBe(
      options("expo-speech-recognition").microphonePermission,
    );
    expect(expo.ios.infoPlist.NSPhotoLibraryUsageDescription).toBe(
      options("expo-image-picker").photosPermission,
    );
  });
});

describe("app variants (app.config.ts)", () => {
  const { expo } = JSON.parse(read("./app.json")) as { expo: Record<string, any> };

  test("production by default: Ponzu, design.ponzu.app, ponzu://", () => {
    const config = configFor(expo, {});
    expect(config.name).toBe("Ponzu");
    expect(config.scheme).toBe("ponzu");
    expect(config.ios?.bundleIdentifier).toBe("design.ponzu.app");
    expect(config.extra?.variant).toBe("production");
    expect(config.extra?.eas).toEqual(expo.extra.eas);
    expect(config.plugins).toContainEqual(["expo-notifications", { mode: "production" }]);
    expect(variantOf({ APP_VARIANT: "staging" })).toBe("production");
  });

  test("APP_VARIANT=dev: Ponzu Dev, design.ponzu.app.dev, ponzu-dev://", () => {
    const config = configFor(expo, { APP_VARIANT: "dev" });
    expect(config.name).toBe("Ponzu Dev");
    expect(config.scheme).toBe("ponzu-dev");
    expect(config.ios?.bundleIdentifier).toBe("design.ponzu.app.dev");
    expect(config.extra?.variant).toBe("dev");
    expect(VARIANTS.dev.bundleIdentifier).not.toBe(VARIANTS.production.bundleIdentifier);
    expect(VARIANTS.dev.scheme).not.toBe(VARIANTS.production.scheme);
  });

  test("push tokens: development for the dev client, production for preview and store builds", () => {
    expect(pushMode("dev", "development")).toBe("development");
    expect(pushMode("dev", undefined)).toBe("development");
    expect(pushMode("dev", "preview")).toBe("production");
    expect(pushMode("production", "production")).toBe("production");
    expect(
      configFor(expo, { APP_VARIANT: "dev", EAS_BUILD_PROFILE: "preview" }).plugins,
    ).toContainEqual(["expo-notifications", { mode: "production" }]);
  });

  test("both apps take universal links on ponzu.design", () => {
    for (const env of [{}, { APP_VARIANT: "dev" }]) {
      expect(configFor(expo, env).ios?.associatedDomains).toEqual(["applinks:ponzu.design"]);
    }
  });

  test("the rest of app.json is kept, PostHog's build plugin only with its key", () => {
    const plain = configFor(expo, {});
    expect(plain.ios?.appleTeamId).toBe(expo.ios.appleTeamId);
    expect(plain.ios?.infoPlist).toEqual(expo.ios.infoPlist);
    expect(plain.plugins?.length).toBe(expo.plugins.length);
    const withKey = configFor(expo, { POSTHOG_CLI_API_KEY: "x" });
    expect(withKey.plugins?.length).toBe(expo.plugins.length + 1);
  });
});
