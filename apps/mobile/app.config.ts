import type { ConfigContext, ExpoConfig } from "expo/config";

/*
 * app.json is the static config (Release Please bumps its version). This adds what depends on
 * the build: which app it is (APP_VARIANT), and PostHog's build plugin.
 *
 * Two apps build from this one project (docs/mobile.md, "Variants"):
 * - `production` (the default): "Ponzu", design.ponzu.app, `ponzu://`. The App Store and
 *   TestFlight app. Nothing from the `cloud` branch is built as it until cutover.
 * - `dev`: "Ponzu Dev", design.ponzu.app.dev, `ponzu-dev://`, against api.ponzu.design and
 *   WorkOS staging. The development client and the preview builds (eas.json) are this one, so
 *   a cloud build can never reach a phone that runs the 1.x app, or TestFlight's groups.
 */

export type Variant = "production" | "dev";

export interface VariantInfo {
  name: string;
  bundleIdentifier: string;
  scheme: "ponzu" | "ponzu-dev";
}

export const VARIANTS: Record<Variant, VariantInfo> = {
  production: { name: "Ponzu", bundleIdentifier: "design.ponzu.app", scheme: "ponzu" },
  dev: { name: "Ponzu Dev", bundleIdentifier: "design.ponzu.app.dev", scheme: "ponzu-dev" },
};

/** The variant APP_VARIANT names; anything else is production, as a store build must be. */
export function variantOf(env: Record<string, string | undefined>): Variant {
  return env.APP_VARIANT === "dev" ? "dev" : "production";
}

/**
 * Which APNs environment the build's entitlement names. A development client is signed for
 * development; a preview build is ad hoc, and ad hoc builds get production tokens.
 */
export function pushMode(
  variant: Variant,
  profile: string | undefined,
): "development" | "production" {
  return variant === "dev" && profile !== "preview" ? "development" : "production";
}

/** The config for one build: the variant's name, ids, scheme and plugins on top of app.json. */
export function configFor(
  config: Partial<ExpoConfig>,
  env: Record<string, string | undefined>,
): Partial<ExpoConfig> {
  const variant = variantOf(env);
  const info = VARIANTS[variant];
  // PostHog's build plugin wraps Xcode's bundle phase with a source map upload that fails
  // without credentials, and only production builds have them. Runtime analytics are separate
  // and keyed on EXPO_PUBLIC_POSTHOG_KEY.
  const sourcemaps: NonNullable<ExpoConfig["plugins"]> = env.POSTHOG_CLI_API_KEY
    ? [["posthog-react-native/expo", { skipOnConflict: true, uploadNativeSymbols: true }]]
    : [];
  const plugins = (config.plugins ?? []).map((plugin) =>
    plugin === "expo-notifications"
      ? (["expo-notifications", { mode: pushMode(variant, env.EAS_BUILD_PROFILE) }] as [
          string,
          unknown,
        ])
      : plugin,
  );
  return {
    ...config,
    name: info.name,
    scheme: info.scheme,
    ios: {
      ...config.ios,
      bundleIdentifier: info.bundleIdentifier,
      // Universal links on ponzu.design, for when a custom scheme isn't enough (WorkOS
      // production may refuse one). The site serves the association file at cutover.
      associatedDomains: ["applinks:ponzu.design"],
    },
    plugins: [...plugins, ...sourcemaps],
    extra: { ...config.extra, variant },
  };
}

// Expo types the incoming config as partial, but app.json supplies name and slug; the return
// type only needs them present.
export default ({ config }: ConfigContext): Partial<ExpoConfig> => configFor(config, process.env);
