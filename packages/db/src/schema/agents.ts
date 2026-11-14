import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { AGENT_TOKEN_KINDS } from "../enums.ts";
import { users } from "./accounts.ts";
import { createdAt, instant, type Json, oneOf } from "./columns.ts";

/*
 * A person's own agent (Claude Code, Codex, Cursor…) connected to Ponzu through its MCP
 * (docs/cloud.md, "Your own agent"). Ponzu is the OAuth authorization server for it: an agent
 * registers itself (`agent_clients`), the person allows it in the signed-in app
 * (`agent_authorizations`), and what that allowed is a grant (`agent_grants`) holding the
 * agent's tokens (`agent_tokens`). Every token is kept only as a hash.
 */

/**
 * An agent that registered itself (OAuth dynamic client registration). Anyone can register
 * one, so nothing here is trusted: its name is the agent's own word, shown as such.
 */
export const agentClients = pgTable("agent_clients", {
  /** `agc_…`. */
  id: text("id").primaryKey(),
  /** What it calls itself (`client_name`), or null when it gave none. */
  name: text("name"),
  redirectUris: text("redirect_uris").array().notNull(),
  /** The whole registration as it was accepted, which the token endpoint answers with. */
  metadata: jsonb("metadata").$type<Json>().notNull(),
  createdAt: createdAt(),
});

/**
 * A person allowed an agent to act as them. It lasts until they revoke it, their account is
 * deleted, or a refresh token of it is used twice (which revokes the whole grant).
 */
export const agentGrants = pgTable(
  "agent_grants",
  {
    /** `agt_…`. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => agentClients.id, { onDelete: "cascade" }),
    /** The agent's name as the person saw it when they allowed it. */
    name: text("name").notNull(),
    /**
     * What the agent last said it is when it called the MCP (its `clientInfo` name and version,
     * as in `claude-code/2.1.0`), so settings can show which agent it really is.
     */
    lastClient: text("last_client"),
    createdAt: createdAt(),
    lastUsedAt: instant("last_used_at"),
    revokedAt: instant("revoked_at"),
  },
  (t) => [index("agent_grants_user_id_idx").on(t.userId)],
);

/** One access or refresh token of a grant. */
export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => agentGrants.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: AGENT_TOKEN_KINDS }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: instant("expires_at").notNull(),
    /** For a refresh token: when it was traded for new tokens. A second trade revokes the grant. */
    usedAt: instant("used_at"),
    revokedAt: instant("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_tokens_grant_id_idx").on(t.grantId),
    index("agent_tokens_expires_at_idx").on(t.expiresAt),
    check("agent_tokens_kind_check", oneOf(t.kind, AGENT_TOKEN_KINDS)),
  ],
);

/**
 * One agent asking to be allowed: what the authorize request said, until the person allows or
 * refuses it in the app, and then the code the agent trades for its tokens (once, within a
 * minute). Fifteen minutes from the ask.
 */
export const agentAuthorizations = pgTable(
  "agent_authorizations",
  {
    /** `aga_…`: what the app's link names. Knowing it lets a signed-in person allow it. */
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => agentClients.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    /** The agent's `state`, given back with the code. */
    state: text("state"),
    scope: text("scope"),
    resource: text("resource"),
    /** Who allowed or refused it. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** What allowing it made. */
    grantId: text("grant_id").references(() => agentGrants.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").unique(),
    codeExpiresAt: instant("code_expires_at"),
    expiresAt: instant("expires_at").notNull(),
    approvedAt: instant("approved_at"),
    deniedAt: instant("denied_at"),
    /** When its code was traded. */
    consumedAt: instant("consumed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_authorizations_expires_at_idx").on(t.expiresAt),
    check(
      "agent_authorizations_decided_check",
      sql`not (${t.approvedAt} is not null and ${t.deniedAt} is not null)`,
    ),
  ],
);
