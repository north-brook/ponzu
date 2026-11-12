/*
 * The switches that turn a feature on, each read from one environment variable (docs/cloud.md,
 * "Environments"). They are built once, in env.ts, and handed down as `deps.features`; nothing
 * else reads the variables. Every switch is off when its variable is unset, so a deployment
 * without a vendor's key, or without the founder's say-so, runs as if the feature did not
 * exist, and every test passes the same way.
 */

export const BILLING_MODES = ["off", "observe", "on"] as const;
export const RATE_LIMIT_MODES = ["off", "vercel"] as const;
export const MAINTENANCE_MODES = ["off", "wakes_paused", "read_only"] as const;

export interface Features {
  /** `PONZU_BILLING`: off; observe (computes the gate and logs what it would refuse); on. */
  billing: (typeof BILLING_MODES)[number];
  /** Whether `EXPO_ACCESS_TOKEN` is set: pings to phones. */
  push: boolean;
  /** Whether `RESEND_API_KEY` is set: the email digest. */
  email: boolean;
  /** `PONZU_REPO_BASES=1`: repo bases are built and woken from. */
  repoBases: boolean;
  /** `PONZU_MERGE_QUEUE=1`: Merge adds to a merge queue instead of refusing. */
  mergeQueue: boolean;
  /** `PONZU_RATE_LIMITS`: off, or limits checked through Vercel's firewall. */
  rateLimits: (typeof RATE_LIMIT_MODES)[number];
  /** `PONZU_MAINTENANCE`: off; wakes paused; or read only. */
  maintenance: (typeof MAINTENANCE_MODES)[number];
}

/** Every switch off: what an environment that sets none of them gets. */
export const FEATURES_OFF: Features = {
  billing: "off",
  push: false,
  email: false,
  repoBases: false,
  mergeQueue: false,
  rateLimits: "off",
  maintenance: "off",
};

/** The variables the switches come from, as env.ts has checked them. */
export interface FeatureVars {
  PONZU_BILLING: Features["billing"];
  EXPO_ACCESS_TOKEN?: string | undefined;
  RESEND_API_KEY?: string | undefined;
  PONZU_REPO_BASES: "0" | "1";
  PONZU_MERGE_QUEUE: "0" | "1";
  PONZU_RATE_LIMITS: Features["rateLimits"];
  PONZU_MAINTENANCE: Features["maintenance"];
}

/** The switches, from the checked variables. Called by env.ts alone. */
export function featuresFrom(vars: FeatureVars): Features {
  return {
    billing: vars.PONZU_BILLING,
    push: vars.EXPO_ACCESS_TOKEN !== undefined,
    email: vars.RESEND_API_KEY !== undefined,
    repoBases: vars.PONZU_REPO_BASES === "1",
    mergeQueue: vars.PONZU_MERGE_QUEUE === "1",
    rateLimits: vars.PONZU_RATE_LIMITS,
    maintenance: vars.PONZU_MAINTENANCE,
  };
}
