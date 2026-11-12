import type { LinkScheme } from "@ponzu/client";

/*
 * Where this build talks to, and who it is: from the EXPO_PUBLIC_* variables (inlined by Metro
 * at bundle time; EAS sets them per environment, `.env.local` for a local run) and the app
 * config (app.config.ts puts the variant in `extra`). None of these is a secret: the WorkOS
 * client id is public, as it is in the Mac app.
 */

export type Variant = "production" | "dev";

export interface CloudConfig {
  /**
   * `https://api.ponzu.design` for Ponzu Dev. Null for a production build that names no API:
   * it must never fall back to the development API, so it talks to none (`requireApiUrl`).
   */
  apiUrl: string | null;
  /** The WorkOS environment's client id; empty when the build has none (sign-in says so). */
  workosClientId: string;
  variant: Variant;
  /** This build's own scheme, and the only one its links may use. */
  scheme: LinkScheme;
  /** The version of the JavaScript running (an update carries its own app.json). */
  version: string;
  /** `Ponzu` or `Ponzu Dev`. */
  appName: string;
}

/**
 * The API Ponzu Dev talks to when the build names none. Production's is always named by its
 * build (EAS's production environment), at cutover.
 */
export const DEV_API_URL = "https://api.ponzu.design";

export const NO_API_URL =
  "This build of Ponzu names no API: set EXPO_PUBLIC_PONZU_API_URL for the production build.";

export interface ConfigInput {
  env: {
    EXPO_PUBLIC_PONZU_API_URL?: string;
    EXPO_PUBLIC_WORKOS_CLIENT_ID?: string;
  };
  /** `expoConfig.extra.variant`, from app.config.ts. */
  variant: unknown;
  /** `expoConfig.version`. */
  version: string | undefined;
}

export function readConfig({ env, variant, version }: ConfigInput): CloudConfig {
  const v: Variant = variant === "dev" ? "dev" : "production";
  // Only Ponzu Dev has a default. A store build with none set is refused, never pointed at dev.
  const named = env.EXPO_PUBLIC_PONZU_API_URL?.trim() || (v === "dev" ? DEV_API_URL : null);
  return {
    apiUrl: named ? named.replace(/\/+$/, "") : null,
    workosClientId: env.EXPO_PUBLIC_WORKOS_CLIENT_ID ?? "",
    variant: v,
    scheme: v === "dev" ? "ponzu-dev" : "ponzu",
    version: version ?? "0.0.0",
    appName: v === "dev" ? "Ponzu Dev" : "Ponzu",
  };
}

/** The API this build talks to; throws for a production build that names none. */
export function requireApiUrl(cfg: CloudConfig): string {
  if (!cfg.apiUrl) throw new Error(NO_API_URL);
  return cfg.apiUrl;
}

let cached: CloudConfig | null = null;

/** This build's config. Read once; expo-constants is required here so bun tests never load it. */
export function config(): CloudConfig {
  if (cached) return cached;
  const Constants = (require("expo-constants") as typeof import("expo-constants")).default;
  const expo = Constants.expoConfig;
  cached = readConfig({
    // Spelled out: Metro inlines only `process.env.EXPO_PUBLIC_*` read by name.
    env: {
      EXPO_PUBLIC_PONZU_API_URL: process.env.EXPO_PUBLIC_PONZU_API_URL,
      EXPO_PUBLIC_WORKOS_CLIENT_ID: process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID,
    },
    variant: (expo?.extra as { variant?: unknown } | undefined)?.variant,
    version: expo?.version,
  });
  return cached;
}
