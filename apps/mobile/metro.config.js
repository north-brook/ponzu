const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const { withNativewind } = require("nativewind/metro");
// PostHog's Expo config stamps every bundle with a debug id, so the source
// maps uploaded at build time match its stack traces.
const { getPostHogExpoConfig } = require("posthog-react-native/metro");

// The canvas web view's page (canvas/dist/bundle.ts), built before Metro bundles anything that
// imports it. It's generated, so it isn't committed.
execFileSync("bun", [join(__dirname, "canvas/build.ts")], { stdio: "inherit" });

module.exports = withNativewind(getPostHogExpoConfig(__dirname));
