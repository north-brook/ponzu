import type { ConfigContext, ExpoConfig } from "expo/config";

// app.json is the static config (Release Please bumps its version). This
// adds PostHog's build plugin only when the build can upload to PostHog: it
// wraps Xcode's bundle phase with a source map upload that fails without
// credentials, and only production builds have them. Runtime telemetry is
// separate and keyed on EXPO_PUBLIC_POSTHOG_KEY, also production-only.
const sourcemaps: NonNullable<ExpoConfig["plugins"]> = process.env.POSTHOG_CLI_API_KEY
  ? [["posthog-react-native/expo", { skipOnConflict: true, uploadNativeSymbols: true }]]
  : [];

// Expo types the incoming config as partial, but app.json supplies name and
// slug; the return type only needs them present.
export default ({ config }: ConfigContext): Partial<ExpoConfig> => ({
  ...config,
  plugins: [...(config.plugins ?? []), ...sourcemaps],
});
