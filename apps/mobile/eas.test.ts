import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

interface Profile {
  bun?: string;
  channel?: string;
  developmentClient?: boolean;
  distribution?: string;
  autoIncrement?: boolean;
  env?: Record<string, string>;
  extends?: string;
  ios?: { simulator?: boolean; distribution?: string; env?: Record<string, string> };
}

interface Job {
  type: string;
  if?: string;
  needs?: string[];
  environment?: string;
  params: Record<string, unknown>;
}

interface Workflow {
  on: { push: { branches?: string[]; tags?: string[]; paths?: string[] } };
  jobs: Record<string, Job>;
}

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const { build } = JSON.parse(read("./eas.json")) as { build: Record<string, Profile> };
const workflow = (name: string) => YAML.parse(read(`./.eas/workflows/${name}`)) as Workflow;

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
  for (const name of ["preview.yml", "production.yml"]) {
    test(`workflow ${name}`, () => {
      expect(read(`./.eas/workflows/${name}`)).toMatch(
        new RegExp(`defaults:\\s+tools:\\s+bun: ${pinned.replaceAll(".", "\\.")}\\n`),
      );
    });
  }
});

// What goes to TestFlight is what testers run: no dev client, no simulator
// binary, no test switches, and a build number EAS raises every time.
describe("store builds are plain release builds", () => {
  for (const name of ["preview", "production"]) {
    test(name, () => {
      const profile = resolved(name);
      expect(profile.developmentClient).toBeFalsy();
      expect(profile.ios?.simulator).toBeFalsy();
      expect(profile.ios?.distribution ?? profile.distribution ?? "store").toBe("store");
      expect(profile.autoIncrement).toBe(true);
      expect(profile.channel).toBe(name);
      const env = { ...profile.env, ...profile.ios?.env };
      expect(Object.keys(env).filter((key) => /TEST/.test(key))).toEqual([]);
    });
  }
});

// A release builds a binary only when native code changed (a new
// fingerprint); every other release ships over the air on its channel.
for (const [name, profile] of [
  ["preview.yml", "preview"],
  ["production.yml", "production"],
] as const) {
  test(`${name}: a new fingerprint builds, an old one updates over the air`, () => {
    const { jobs } = workflow(name);
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
    expect(update?.params).toMatchObject({ branch: profile, platform: "ios" });
  });
}

test("production runs on a mobile tag and sends a new binary to the Alpha group", () => {
  const { on, jobs } = workflow("production.yml");
  expect(on.push.tags).toEqual(["mobile-v*"]);
  const submission = jobs.submit_ios;
  expect(submission?.type).toBe("testflight");
  expect(submission?.needs).toEqual(["build_ios"]);
  expect(submission?.params).toMatchObject({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: EAS resolves this workflow expression.
    build_id: "${{ needs.build_ios.outputs.build_id }}",
    external_groups: ["Alpha"],
    submit_beta_review: true,
  });
  expect(String(submission?.params.changelog ?? "").trim()).not.toBe("");
});

test("preview runs on main when the phone or what it bundles changes", () => {
  const { on } = workflow("preview.yml");
  expect(on.push.branches).toEqual(["main"]);
  // The canvas and icons import packages/react's and packages/render's source by path.
  expect(on.push.paths).toEqual([
    "apps/mobile/**",
    "packages/core/**",
    "packages/react/**",
    "packages/render/**",
    "patches/**",
    "bun.lock",
  ]);
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

  test("an update reaches only binaries with the same native code", () => {
    expect(expo.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(expo.updates.url).toBe(`https://u.expo.dev/${expo.extra.eas.projectId}`);
  });

  test("the phone shares the Mac app's bundle id", () => {
    expect(expo.ios.bundleIdentifier).toBe("design.ponzu.app");
  });

  test("Bonjour browses only Ponzu's service, and plain http reaches only the tailnet", () => {
    const plist = expo.ios.infoPlist;
    expect(plist.NSBonjourServices).toEqual(["_ponzu._tcp"]);
    expect(plist.NSLocalNetworkUsageDescription).toBeString();
    const ats = plist.NSAppTransportSecurity;
    expect(ats.NSAllowsArbitraryLoads).toBeUndefined();
    expect(ats.NSAllowsLocalNetworking).toBe(true);
    expect(Object.keys(ats.NSExceptionDomains)).toEqual(["ts.net"]);
    expect(ats.NSExceptionDomains["ts.net"]).toEqual({
      NSIncludesSubdomains: true,
      NSExceptionAllowsInsecureHTTPLoads: true,
    });
  });

  test("every permission says why", () => {
    const options = (name: string) =>
      (expo.plugins.find((p) => Array.isArray(p) && p[0] === name) as [string, any])[1];
    expect(options("expo-camera").cameraPermission).toBeString();
    expect(options("expo-speech-recognition").speechRecognitionPermission).toBeString();
    expect(options("expo-speech-recognition").microphonePermission).toBeString();
  });
});
