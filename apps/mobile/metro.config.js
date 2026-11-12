const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { withNativewind } = require("nativewind/metro");
// PostHog's Expo config stamps every bundle with a debug id, so the source
// maps uploaded at build time match its stack traces.
const { getPostHogExpoConfig } = require("posthog-react-native/metro");
const { backendFile, isSingleton, outsideApp } = require("./metro.resolve");

// The canvas web view's page (canvas/dist/bundle.ts), built before Metro bundles anything that
// imports it. It's generated, so it isn't committed.
execFileSync("bun", [join(__dirname, "canvas/build.ts")], { stdio: "inherit" });

const config = getPostHogExpoConfig(__dirname);

// Which Ponzu Cloud the bundle talks to (lib/cloud/backend.ts): the real one, or with
// PONZU_BACKEND=fake the in-app fake (lib/cloud/backend.fake.ts), for Maestro and demos. Chosen
// here, at bundle time, so a real build never carries the fake or its test code.
const fake = process.env.PONZU_BACKEND === "fake";
const appRoot = join(__dirname, "package.json");
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const next = resolve ?? context.resolveRequest;
  const swapped = fake ? backendFile(context.originModulePath, moduleName, __dirname) : null;
  if (swapped) return { type: "sourceFile", filePath: swapped };
  // One React, one TanStack Query: from the app, whoever imports them (metro.resolve.js).
  if (isSingleton(moduleName) && outsideApp(context.originModulePath, __dirname)) {
    return next({ ...context, originModulePath: appRoot }, moduleName, platform);
  }
  return next(context, moduleName, platform);
};

module.exports = withNativewind(config);
