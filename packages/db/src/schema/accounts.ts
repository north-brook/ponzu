import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  AUTH_STATE_KINDS,
  BASE_STATUSES,
  CLAUDE_ACCOUNT_KINDS,
  CLAUDE_ACCOUNT_STATUSES,
  DEVICE_PLATFORMS,
  GITHUB_ACCESS,
  MEMBER_ROLES,
  PUSH_ENVIRONMENTS,
  REPO_PERMISSIONS,
  REPOSITORY_SELECTIONS,
  WORKSPACE_KINDS,
} from "../enums.ts";
import { createdAt, instant, type Json, oneOf, updatedAt } from "./columns.ts";

/** One runtime, package manager or service in a repo's base, as Settings shows it. */
export interface StackItem {
  slug: string;
  label: string;
}

/** One window of a Claude plan's own limits, as the runner last saw it. */
export interface ClaudeLimit {
  window: "session" | "week" | "week_opus";
  /** 0 to 1. */
  utilization: number;
  /** ISO 8601. */
  resetsAt: string;
}

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  workosUserId: text("workos_user_id").notNull().unique(),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  // What the create composer starts on. Null means the product's default.
  defaultAgent: text("default_agent"),
  defaultModel: text("default_model"),
  defaultEffort: text("default_effort"),
  pingNeedsYou: boolean("ping_needs_you").notNull().default(true),
  pingReplies: boolean("ping_replies").notNull().default(true),
  pingPrReady: boolean("ping_pr_ready").notNull().default(true),
  pingTeammateComments: boolean("ping_teammate_comments").notNull().default(true),
  emailDigest: boolean("email_digest").notNull().default(false),
  // Guided setup: when each step that has no other trace was finished.
  onboardingWhereAt: instant("onboarding_where_at"),
  onboardingIphoneAt: instant("onboarding_iphone_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A WorkOS session the API let in through its sign-in exchange, which is where the person's
 * GitHub identity is checked. An access token is honored only if its session is here: WorkOS
 * will issue a token to anyone who signs in with it directly, and that proves less.
 */
export const sessions = pgTable(
  "sessions",
  {
    /** WorkOS's id for the session: the `sid` of every access token it issues for it. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const githubUserTokens = pgTable("github_user_tokens", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  accessTokenExpiresAt: instant("access_token_expires_at"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  refreshTokenExpiresAt: instant("refresh_token_expires_at"),
  /**
   * Set while one function instance is refreshing the token with GitHub. A refresh token works
   * once, so two instances must never send the same one; the others wait for this to clear.
   */
  refreshClaimedUntil: instant("refresh_claimed_until"),
  updatedAt: updatedAt(),
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    // The GitHub account is the identity. An uninstall and reinstall changes the installation
    // and must come back to the same workspace and its designs.
    githubAccountId: bigint("github_account_id", { mode: "number" }).notNull().unique(),
    githubLogin: text("github_login").notNull(),
    kind: text("kind", { enum: WORKSPACE_KINDS }).notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    /** Null while the App is not installed on the account. */
    installationId: bigint("installation_id", { mode: "number" }).unique(),
    repositorySelection: text("repository_selection", { enum: REPOSITORY_SELECTIONS }),
    installedByUserId: text("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    installedAt: instant("installed_at"),
    suspendedAt: instant("suspended_at"),
    /** When the installation was last read from GitHub as the App. Null: never. */
    reconciledAt: instant("reconciled_at"),
    stripeCustomerId: text("stripe_customer_id").unique(),
    /** Null until someone sets one; the rate card's default applies until then. */
    monthlyCapCents: integer("monthly_cap_cents"),
    /** Billing periods are months counted from here. */
    billingPeriodAnchor: instant("billing_period_anchor").notNull().defaultNow(),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    pastDueAt: instant("past_due_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("workspaces_kind_check", oneOf(t.kind, WORKSPACE_KINDS)),
    check(
      "workspaces_repository_selection_check",
      oneOf(t.repositorySelection, REPOSITORY_SELECTIONS),
    ),
    check("workspaces_monthly_cap_cents_check", sql`${t.monthlyCapCents} >= 0`),
  ],
);

/** Who can reach a workspace is GitHub's to say; the row is a cache of that. Only `role` is ours. */
export const memberships = pgTable(
  "memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    /** How GitHub last said they reach it. An owner is always an admin. */
    githubAccess: text("github_access", { enum: GITHUB_ACCESS }).notNull().default("collaborator"),
    /** When GitHub last confirmed the person can reach the installation. */
    syncedAt: instant("synced_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("memberships_user_id_idx").on(t.userId),
    check("memberships_role_check", oneOf(t.role, MEMBER_ROLES)),
    check("memberships_github_access_check", oneOf(t.githubAccess, GITHUB_ACCESS)),
  ],
);

/**
 * Installations GitHub has said are gone. GitHub never reuses an installation id (a reinstall
 * gets a new one), so a read of GitHub that began before the uninstall cannot bring it back.
 */
export const uninstalledInstallations = pgTable("uninstalled_installations", {
  installationId: bigint("installation_id", { mode: "number" }).primaryKey(),
  uninstalledAt: instant("uninstalled_at").notNull().defaultNow(),
});

export const repos = pgTable(
  "repos",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull().unique(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    private: boolean("private").notNull().default(false),
    pushedAt: instant("pushed_at"),
    /** The provider snapshot new designs in this repo start from. */
    baseSnapshot: text("base_snapshot"),
    baseStatus: text("base_status", { enum: BASE_STATUSES }).notNull().default("none"),
    baseBuiltAt: instant("base_built_at"),
    baseError: text("base_error"),
    stack: jsonb("stack").$type<StackItem[]>().notNull().default([]),
    /** Prompts to start from, grounded in the repo. */
    ideas: jsonb("ideas").$type<string[]>().notNull().default([]),
    ideasGeneratedAt: instant("ideas_generated_at"),
    /** Set when the App loses the repo. The row stays because designs point at it. */
    removedAt: instant("removed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("repos_workspace_id_idx").on(t.workspaceId),
    // What a design's foreign key points at, so a design is always in its repo's workspace.
    unique("repos_id_workspace_id_key").on(t.id, t.workspaceId),
    check("repos_base_status_check", oneOf(t.baseStatus, BASE_STATUSES)),
  ],
);

/**
 * What GitHub last said a person may do in a repo, and when: the one answer to "may this person
 * see or steer this repo", for every route and live query that asks (`auth/repo-access.ts` in
 * the API). Two kinds of answer land here, both GitHub's: a sync of the person, which lists
 * every repo of an installation their own token reaches (`write` or `read`, and `none` for the
 * workspace's others), and a question asked as the App about one repo when no answer is fresh.
 * Every function instance reads it, so one answer serves them all, and live queries join it:
 * Realtime has no row-level security, so this is how a list shows a repo's designs only to
 * people who can read the repo. A row is only ever replaced by a newer answer, and a webhook
 * that says access may have changed makes the answers it concerns stale (`checked_at` at the
 * epoch), so they are asked again before they are trusted.
 *
 * It answers only for a member of the repo's workspace: whoever reads it also requires the
 * membership, so a person who leaves a workspace loses its repos at once, whatever is here.
 */
export const repoAccess = pgTable(
  "repo_access",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    permission: text("permission", { enum: REPO_PERMISSIONS }).notNull(),
    /** When GitHub was asked for this answer, by the API's clock. */
    checkedAt: instant("checked_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.repoId] }),
    index("repo_access_repo_id_idx").on(t.repoId),
    check("repo_access_permission_check", oneOf(t.permission, REPO_PERMISSIONS)),
  ],
);

export const repoSecrets = pgTable(
  "repo_secrets",
  {
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** The environment variable the sandbox receives. */
    name: text("name").notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.name] }),
    check("repo_secrets_name_check", sql`${t.name} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
  ],
);

/** A person's own Claude: a subscription token or an API key. One per person. */
export const claudeAccounts = pgTable(
  "claude_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: CLAUDE_ACCOUNT_KINDS }).notNull(),
    status: text("status", { enum: CLAUDE_ACCOUNT_STATUSES }).notNull().default("connected"),
    /**
     * The subscription token or the API key, sealed to this row. Destroyed when the person
     * disconnects: the row stays, `revoked`, so the designs that run on it keep pointing at it,
     * and connecting again fills it in.
     */
    encryptedCredential: text("encrypted_credential"),
    planLabel: text("plan_label"),
    email: text("email"),
    /** The last four characters of an API key. */
    keyHint: text("key_hint"),
    connectedAt: instant("connected_at").notNull().defaultNow(),
    expiresAt: instant("expires_at"),
    limits: jsonb("limits").$type<ClaudeLimit[]>(),
    limitsObservedAt: instant("limits_observed_at"),
    /** Set while the plan is at a limit; designs on this account wait until then. */
    limitedUntil: instant("limited_until"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("claude_accounts_kind_check", oneOf(t.kind, CLAUDE_ACCOUNT_KINDS)),
    check("claude_accounts_status_check", oneOf(t.status, CLAUDE_ACCOUNT_STATUSES)),
    check(
      "claude_accounts_credential_check",
      sql`(${t.status} = 'revoked') = (${t.encryptedCredential} is null)`,
    ),
  ],
);

export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: DEVICE_PLATFORMS }).notNull(),
    pushToken: text("push_token").notNull().unique(),
    pushEnvironment: text("push_environment", { enum: PUSH_ENVIRONMENTS }).notNull(),
    name: text("name"),
    appVersion: text("app_version"),
    pingsEnabled: boolean("pings_enabled").notNull().default(true),
    lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("devices_user_id_idx").on(t.userId),
    check("devices_platform_check", oneOf(t.platform, DEVICE_PLATFORMS)),
    check("devices_push_environment_check", oneOf(t.pushEnvironment, PUSH_ENVIRONMENTS)),
  ],
);

/**
 * A round trip through someone else's page that has to come back to the person who started it:
 * the `state` of a GitHub App install, or a Claude sign-in waiting for its pasted code.
 */
export const authStates = pgTable(
  "auth_states",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: AUTH_STATE_KINDS }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Json>().notNull().default({}),
    expiresAt: instant("expires_at").notNull(),
    consumedAt: instant("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("auth_states_expires_at_idx").on(t.expiresAt),
    // A person has one Claude sign-in open at a time, each with a sandbox of its own.
    uniqueIndex("auth_states_open_claude_sign_in_key")
      .on(t.userId)
      .where(sql`${t.kind} = 'claude_sign_in' and ${t.consumedAt} is null`),
    check("auth_states_kind_check", oneOf(t.kind, AUTH_STATE_KINDS)),
  ],
);
