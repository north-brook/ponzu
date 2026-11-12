import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
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
  type RepoPermission,
  WORKSPACE_KINDS,
} from "../enums.ts";
import { createdAt, instant, type Json, oneOf, updatedAt } from "./columns.ts";

/** One runtime, package manager or service in a repo's base, as Settings shows it. */
export interface StackItem {
  slug: string;
  label: string;
}

/**
 * One window of a Claude plan's own limits, as a runner on the account's credential last saw it
 * (docs/cloud.md, "Claude plan limits"). Kept as the Agent SDK named it, so a window the apps do
 * not know yet is kept and simply not shown.
 */
export interface ClaudeLimit {
  /** The SDK's `rateLimitType`: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, … */
  window: string;
  /** The share used, from 0 (it can run a little past 1); null when Claude Code did not say. */
  utilization: number | null;
  /** ISO 8601; null when Claude Code did not say. */
  resetsAt: string | null;
  /** When a runner reported it, ISO 8601. */
  at: string;
}

/**
 * One model Claude Code offers an account, as its runner last reported it: an entry of the Agent
 * SDK's `supportedModels()`, kept as the SDK said it (docs/cloud.md, "Models"). The API turns
 * these into what the apps offer, so a change to how it does needs no new report.
 */
export interface ClaudeModelReport {
  /** What Claude Code takes as a model: an alias (`opus`, `default`) or a full id. */
  value: string;
  /** The full id `value` runs as now (`claude-opus-5-5`), when Claude Code says. */
  resolvedModel: string | null;
  displayName: string;
  description: string;
  /** The effort levels it takes; empty when it takes none, null when Claude Code did not say. */
  efforts: ("low" | "medium" | "high" | "xhigh" | "max")[] | null;
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
  pingTeammateComments: boolean("ping_teammate_comments").notNull().default(false),
  emailDigest: boolean("email_digest").notNull().default(false),
  /** The IANA time zone the person's app reports, for the daily email's hour. Null: unknown. */
  timeZone: text("time_zone"),
  /** The local date of the last daily email, so it goes at most once a day. */
  digestSentOn: date("digest_sent_on", { mode: "string" }),
  // Settings › Account › Share usage data: false stops the apps', the API's and the agent's
  // analytics about this person (docs/analytics.md, "Turning it off").
  shareUsage: boolean("share_usage").notNull().default(true),
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
    // and must come back to the same workspace and its canvases.
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
    /**
     * The workspace's allowance of repo idea generations (`ideas` on `repos`): how many were
     * started in the window that began at `ideas_window_started_at`. Ponzu pays for them.
     */
    ideasWindowStartedAt: instant("ideas_window_started_at"),
    ideasWindowCount: integer("ideas_window_count").notNull().default(0),
    /**
     * When `workspace_people` was last read from GitHub as the App, by the API's clock. Null:
     * never, so how many people can reach the workspace is not known yet.
     */
    peopleSyncedAt: instant("people_synced_at"),
    /** False when that read was cut short: someone missing from it may still have access. */
    peopleComplete: boolean("people_complete").notNull().default(false),
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
 * Everyone GitHub says can reach a workspace: the people with access to at least one repo of
 * its installation, read as the App (`github/people.ts` in the API), whether or not they have
 * opened Ponzu. No `users` row is made for them; someone who signs in is matched by their
 * GitHub id. It says who is in the team (the count, Settings › Members, Share) and nothing
 * more: what a person may do in Ponzu is still `memberships` and `repo_access`, from their own
 * sync, and for anyone with a `repo_access` answer that answer wins over `repo_permissions`
 * here, which is never consulted to grant anything. A repo whose list of people was read whole
 * replaces its entry in everyone's `repo_permissions`; someone left reaching no repo is deleted.
 */
export const workspacePeople = pgTable(
  "workspace_people",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    githubUserId: bigint("github_user_id", { mode: "number" }).notNull(),
    githubLogin: text("github_login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    /** How they reach it: they own the account, they are in its organization, or neither. */
    githubAccess: text("github_access", { enum: GITHUB_ACCESS }).notNull(),
    /** The most GitHub lets them do in any of its repos: never `none`. */
    permission: text("permission", { enum: REPO_PERMISSIONS }).notNull(),
    /**
     * What they may do in each repo they reach, by GitHub repo id, as the App last read each
     * repo: a display-only snapshot, chiefly of people who have not opened Ponzu.
     */
    repoPermissions: jsonb("repo_permissions")
      .$type<Record<string, RepoPermission>>()
      .notNull()
      .default({}),
    /** When a read of GitHub last found them, by the API's clock. */
    lastSeenAt: instant("last_seen_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.githubUserId] }),
    index("workspace_people_github_user_id_idx").on(t.githubUserId),
    check("workspace_people_github_access_check", oneOf(t.githubAccess, GITHUB_ACCESS)),
    check("workspace_people_permission_check", oneOf(t.permission, REPO_PERMISSIONS)),
    check("workspace_people_permission_not_none_check", sql`${t.permission} <> 'none'`),
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
    /**
     * When the default branch last moved: the API's clock as GitHub's push webhook for it came
     * in. Null: none has been heard since the App could see the repo. (`pushed_at` is GitHub's
     * own, for any branch, a canvas's included, and only as fresh as the last read of the list.)
     */
    defaultPushedAt: instant("default_pushed_at"),
    /** The provider snapshot new canvases in this repo start from. */
    baseSnapshot: text("base_snapshot"),
    baseStatus: text("base_status", { enum: BASE_STATUSES }).notNull().default("none"),
    baseBuiltAt: instant("base_built_at"),
    baseError: text("base_error"),
    /**
     * When someone asked for the base to be made again. The sandbox side of building a base is
     * not built yet, so this only records that the repo's next start should rebuild it.
     */
    baseRebuildRequestedAt: instant("base_rebuild_requested_at"),
    stack: jsonb("stack").$type<StackItem[]>().notNull().default([]),
    /** Prompts to start from, grounded in the repo: the API's `ideas/` writes them. */
    ideas: jsonb("ideas").$type<string[]>().notNull().default([]),
    /** When `ideas` were last written, an empty list included. Null: never. */
    ideasGeneratedAt: instant("ideas_generated_at"),
    /**
     * Which way of making ideas wrote `ideas` (the API's `IDEAS_VERSION`; 0, before there was
     * one). An empty list an earlier way wrote is made again at the next ask, push or not: a
     * later way may find ideas where it found none.
     */
    ideasVersion: integer("ideas_version").notNull().default(0),
    /**
     * When an instance last took on generating them. It holds the work for one instance at a
     * time, and is not taken again for a while after, whether that generation ended or not.
     */
    ideasClaimedAt: instant("ideas_claimed_at"),
    /** Set when the App loses the repo. The row stays because canvases point at it. */
    removedAt: instant("removed_at"),
    /**
     * When the API last read who can reach this repo as the App (`workspace_people`), by its
     * clock. Null: never. A read takes the repos read longest ago first, so an installation with
     * more repos than one read takes is read whole over a few.
     */
    peopleReadAt: instant("people_read_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("repos_workspace_id_idx").on(t.workspaceId),
    // What a canvas's foreign key points at, so a canvas is always in its repo's workspace.
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
 * Realtime has no row-level security, so this is how a list shows a repo's canvases only to
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
    /** The value's length in UTF-8 bytes, so a repo's secrets fit what a sandbox's env takes. */
    valueBytes: integer("value_bytes").notNull().default(0),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.repoId, t.name] }),
    check("repo_secrets_name_check", sql`${t.name} ~ '^[A-Za-z_][A-Za-z0-9_]*$'`),
    check("repo_secrets_value_bytes_check", sql`${t.valueBytes} >= 0`),
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
     * disconnects: the row stays, `revoked`, so the canvases that run on it keep pointing at it,
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
    /** Set while the plan is at a limit; canvases on this account wait until then. */
    limitedUntil: instant("limited_until"),
    /**
     * The models Claude Code offered this credential, as a runner on it last reported; when, and
     * which Claude Code said so. Null until a runner has; cleared when the credential changes.
     */
    models: jsonb("models").$type<ClaudeModelReport[]>(),
    modelsReportedAt: instant("models_reported_at"),
    modelsClaudeCode: text("models_claude_code"),
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
    /**
     * An iPhone's Expo push token (`ExponentPushToken[…]`), which pings go to. A Mac has none:
     * it shows its own notifications while the app runs, from the live inbox.
     */
    pushToken: text("push_token").unique(),
    /** Which APNs an iPhone's token is for: a development build's or the App Store's. */
    pushEnvironment: text("push_environment", { enum: PUSH_ENVIRONMENTS }),
    /**
     * The install of the app: a random id it keeps (in the Keychain on the phone, beside the
     * session on the Mac). A device is an install: one row per person and install. Only the
     * same install may move a token to another person (the phone signed in as someone else).
     * Null for a row registered before it was asked for.
     */
    installId: text("install_id"),
    name: text("name"),
    appVersion: text("app_version"),
    pingsEnabled: boolean("pings_enabled").notNull().default(true),
    /** The phone's own settings turned Ponzu's notifications off: nothing can reach it. */
    pingsBlocked: boolean("pings_blocked").notNull().default(false),
    lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
    /**
     * When the person was last at this install: a Mac with a window focused and input in the
     * last two minutes, a phone in the foreground. A person at a Mac gets its banner first, and
     * their phone waits.
     */
    activeAt: instant("active_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("devices_user_id_idx").on(t.userId),
    uniqueIndex("devices_user_install_key")
      .on(t.userId, t.installId)
      .where(sql`${t.installId} is not null`),
    check("devices_platform_check", oneOf(t.platform, DEVICE_PLATFORMS)),
    check("devices_push_environment_check", oneOf(t.pushEnvironment, PUSH_ENVIRONMENTS)),
    // An iPhone is reached by its token; a Mac has none.
    check("devices_push_token_check", sql`(${t.platform} = 'ios') = (${t.pushToken} is not null)`),
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
