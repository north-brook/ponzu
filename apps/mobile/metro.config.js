const { withNativewind } = require("nativewind/metro");
// PostHog's Expo config stamps every bundle with a debug id, so the source
// maps uploaded at build time match its stack traces.
const { getPostHogExpoConfig } = require("posthog-react-native/metro");

module.exports = withNativewind(getPostHogExpoConfig(__dirname));
