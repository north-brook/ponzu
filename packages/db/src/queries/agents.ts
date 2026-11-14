import { and, desc, eq, getTableColumns, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { newId, randomString } from "../ids.ts";
import type { Json } from "../schema/columns.ts";
import {
  agentAuthorizations,
  agentClients,
  agentGrants,
  agentTokens,
  users,
} from "../schema/index.ts";
import type { User } from "./accounts.ts";
import { run } from "./run.ts";

/*
 * A person's own agent connected through Ponzu's MCP (docs/cloud.md, "Your own agent"): its
 * registration, the person allowing it, and the tokens it holds. Tokens and codes are returned
 * once, where they are made, and kept only as hashes.
 */

export type AgentClient = typeof agentClients.$inferSelect;
export type AgentGrant = typeof agentGrants.$inferSelect;

/** How long an access token lasts. */
export const AGENT_ACCESS_SECONDS = 60 * 60;
/** How long a refresh token lasts. Each use makes a new one. */
export const AGENT_REFRESH_SECONDS = 60 * 24 * 60 * 60;
/** How long an ask waits for the person in the app. */
export const AGENT_AUTHORIZATION_SECONDS = 15 * 60;
/** How long the code an allowed ask gives the agent lasts. */
export const AGENT_CODE_SECONDS = 60;

/** Record an agent that registered itself. */
export async function registerAgentClient(
  db: Db,
  client: { name: string | null; redirectUris: string[]; metadata: Json },
): Promise<AgentClient> {
  const [row] = await run(
    db
      .insert(agentClients)
      .values({ id: newId("agc"), ...client })
      .returning(),
  );
  return row!;
}

export async function getAgentClient(db: Db, id: string): Promise<AgentClient | null> {
  const [row] = await run(db.select().from(agentClients).where(eq(agentClients.id, id)));
  return row ?? null;
}

/** Record an agent's ask, which the person allows or refuses in the app. Answers its id. */
export async function createAgentAuthorization(
  db: Db,
  ask: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state: string | null;
    scope: string | null;
    resource: string | null;
  },
): Promise<string> {
  const id = newId("aga");
  await run(
    db.insert(agentAuthorizations).values({
      id,
      ...ask,
      expiresAt: sql`now() + make_interval(secs => ${AGENT_AUTHORIZATION_SECONDS})`,
    }),
  );
  return id;
}

/** An ask still waiting for the person, with its agent; null once decided, or past its time. */
export interface OpenAgentAuthorization {
  id: string;
  clientName: string | null;
  redirectUri: string;
  expiresAt: Date;
}

export async function getOpenAgentAuthorization(
  db: Db,
  id: string,
): Promise<OpenAgentAuthorization | null> {
  const [row] = await run(
    db
      .select({
        id: agentAuthorizations.id,
        clientName: agentClients.name,
        redirectUri: agentAuthorizations.redirectUri,
        expiresAt: agentAuthorizations.expiresAt,
      })
      .from(agentAuthorizations)
      .innerJoin(agentClients, eq(agentClients.id, agentAuthorizations.clientId))
      .where(
        and(
          eq(agentAuthorizations.id, id),
          isNull(agentAuthorizations.approvedAt),
          isNull(agentAuthorizations.deniedAt),
          gt(agentAuthorizations.expiresAt, sql`now()`),
        ),
      ),
  );
  return row ?? null;
}

/** Where the person's decision sends the agent back to. */
export interface AgentAuthorizationReturn {
  redirectUri: string;
  state: string | null;
}

/**
 * The person allows an open ask: a grant for them, named as they saw the agent, and a code for
 * the agent, good for a minute. Null when the ask is gone, decided or past its time. One
 * statement, so two presses make one grant.
 */
export async function approveAgentAuthorization(
  db: Db,
  { id, userId, name }: { id: string; userId: string; name: string },
): Promise<(AgentAuthorizationReturn & { code: string; grantId: string }) | null> {
  const code = `pzc_${randomString(40)}`;
  const grantId = newId("agt");
  const rows = await run(
    db.execute<{ redirect_uri: string; state: string | null }>(sql`
      with ask as (
        update ${agentAuthorizations}
        set user_id = ${userId}, approved_at = now(), grant_id = ${grantId},
            code_hash = ${await hash(code)},
            code_expires_at = now() + make_interval(secs => ${AGENT_CODE_SECONDS})
        where id = ${id} and approved_at is null and denied_at is null and expires_at > now()
        returning client_id, redirect_uri, state
      ), granted as (
        insert into ${agentGrants} (id, user_id, client_id, name)
        select ${grantId}, ${userId}, client_id, ${name} from ask
        returning id
      )
      select ask.redirect_uri, ask.state from ask, granted
    `),
  );
  const [row] = (rows as unknown as { rows: { redirect_uri: string; state: string | null }[] })
    .rows;
  if (!row) return null;
  return { redirectUri: row.redirect_uri, state: row.state, code, grantId };
}

/** The person refuses an open ask. Null when it is gone, decided or past its time. */
export async function denyAgentAuthorization(
  db: Db,
  { id, userId }: { id: string; userId: string },
): Promise<AgentAuthorizationReturn | null> {
  const [row] = await run(
    db
      .update(agentAuthorizations)
      .set({ userId, deniedAt: sql`now()` })
      .where(
        and(
          eq(agentAuthorizations.id, id),
          isNull(agentAuthorizations.approvedAt),
          isNull(agentAuthorizations.deniedAt),
          gt(agentAuthorizations.expiresAt, sql`now()`),
        ),
      )
      .returning({
        redirectUri: agentAuthorizations.redirectUri,
        state: agentAuthorizations.state,
      }),
  );
  return row ?? null;
}

/** What an unused, unexpired code was issued for, without using it. */
export interface AgentCode {
  clientId: string;
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
}

export async function getAgentCode(db: Db, code: string): Promise<AgentCode | null> {
  const [row] = await run(
    db
      .select({
        clientId: agentAuthorizations.clientId,
        grantId: agentAuthorizations.grantId,
        redirectUri: agentAuthorizations.redirectUri,
        codeChallenge: agentAuthorizations.codeChallenge,
        resource: agentAuthorizations.resource,
      })
      .from(agentAuthorizations)
      .where(
        and(
          eq(agentAuthorizations.codeHash, await hash(code)),
          isNull(agentAuthorizations.consumedAt),
          gt(agentAuthorizations.codeExpiresAt, sql`now()`),
        ),
      ),
  );
  if (!row?.grantId) return null;
  return { ...row, grantId: row.grantId };
}

/**
 * Use a code, once: answers its grant, or null when it was used already, ran out, or is not
 * this agent's. A code used twice revokes the grant it made (OAuth 2.1: it was stolen, or the
 * agent is broken).
 */
export async function consumeAgentCode(
  db: Db,
  { code, clientId }: { code: string; clientId: string },
): Promise<string | null> {
  const codeHash = await hash(code);
  const [row] = await run(
    db
      .update(agentAuthorizations)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(agentAuthorizations.codeHash, codeHash),
          eq(agentAuthorizations.clientId, clientId),
          isNull(agentAuthorizations.consumedAt),
          gt(agentAuthorizations.codeExpiresAt, sql`now()`),
        ),
      )
      .returning({ grantId: agentAuthorizations.grantId }),
  );
  if (row?.grantId) return row.grantId;
  const [used] = await run(
    db
      .select({ grantId: agentAuthorizations.grantId })
      .from(agentAuthorizations)
      .where(
        and(
          eq(agentAuthorizations.codeHash, codeHash),
          sql`${agentAuthorizations.consumedAt} is not null`,
        ),
      ),
  );
  if (used?.grantId) await revokeGrant(db, used.grantId);
  return null;
}

/** A new access token and refresh token for a grant. */
export interface AgentTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function issueAgentTokens(db: Db, grantId: string): Promise<AgentTokens> {
  const accessToken = `pza_${randomString(52)}`;
  const refreshToken = `pzf_${randomString(52)}`;
  await run(
    db.insert(agentTokens).values([
      {
        id: newId("agk"),
        grantId,
        kind: "access",
        tokenHash: await hash(accessToken),
        expiresAt: sql`now() + make_interval(secs => ${AGENT_ACCESS_SECONDS})`,
      },
      {
        id: newId("agk"),
        grantId,
        kind: "refresh",
        tokenHash: await hash(refreshToken),
        expiresAt: sql`now() + make_interval(secs => ${AGENT_REFRESH_SECONDS})`,
      },
    ]),
  );
  return { accessToken, refreshToken, expiresIn: AGENT_ACCESS_SECONDS };
}

/**
 * Trade a refresh token for new tokens. Answers the grant it was for, or null when it is not a
 * live refresh token of this agent's. One used before revokes its whole grant: only a thief or
 * a broken agent sends a refresh token twice.
 */
export async function useAgentRefreshToken(
  db: Db,
  { refreshToken, clientId }: { refreshToken: string; clientId: string },
): Promise<string | null> {
  const tokenHash = await hash(refreshToken);
  const [row] = await run(
    db.execute<{ grant_id: string; used: boolean }>(sql`
      with found as (
        select t.id, t.grant_id, t.used_at is not null as used
        from ${agentTokens} t join ${agentGrants} g on g.id = t.grant_id
        where t.token_hash = ${tokenHash} and t.kind = 'refresh' and t.revoked_at is null
          and t.expires_at > now() and g.revoked_at is null and g.client_id = ${clientId}
        for update of t
      ), used as (
        update ${agentTokens} set used_at = now()
        where id in (select id from found where not used)
        returning id
      )
      select grant_id, used from found
    `),
  ).then((result) => (result as unknown as { rows: { grant_id: string; used: boolean }[] }).rows);
  if (!row) return null;
  if (row.used) {
    await revokeGrant(db, row.grant_id);
    return null;
  }
  return row.grant_id;
}

/** Who an access token acts for, and through which grant; null when it isn't live. */
export interface AgentTokenOwner {
  grant: AgentGrant;
  user: User;
}

export async function verifyAgentToken(db: Db, token: string): Promise<AgentTokenOwner | null> {
  if (!token.startsWith("pza_")) return null;
  const [row] = await run(
    db
      .select({ grant: getTableColumns(agentGrants), user: getTableColumns(users) })
      .from(agentTokens)
      .innerJoin(agentGrants, eq(agentGrants.id, agentTokens.grantId))
      .innerJoin(users, eq(users.id, agentGrants.userId))
      .where(
        and(
          eq(agentTokens.tokenHash, await hash(token)),
          eq(agentTokens.kind, "access"),
          isNull(agentTokens.revokedAt),
          gt(agentTokens.expiresAt, sql`now()`),
          isNull(agentGrants.revokedAt),
        ),
      ),
  );
  return row ?? null;
}

/**
 * Note that a grant was used, and what the agent said it is. Written at most once a minute
 * per grant, unless the agent says it is something else now.
 */
export async function touchAgentGrant(
  db: Db,
  { grantId, client }: { grantId: string; client: string | null },
): Promise<void> {
  await run(
    db
      .update(agentGrants)
      .set({ lastUsedAt: sql`now()`, ...(client ? { lastClient: client } : {}) })
      .where(
        and(
          eq(agentGrants.id, grantId),
          or(
            isNull(agentGrants.lastUsedAt),
            lt(agentGrants.lastUsedAt, sql`now() - interval '1 minute'`),
            client ? sql`${agentGrants.lastClient} is distinct from ${client}` : undefined,
          ),
        ),
      ),
  );
}

/** Revoke one token the agent hands back (RFC 7009). Unknown tokens are not an error. */
export async function revokeAgentToken(
  db: Db,
  { token, clientId }: { token: string; clientId: string },
): Promise<void> {
  const tokenHash = await hash(token);
  await run(
    db
      .update(agentTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(agentTokens.tokenHash, tokenHash),
          isNull(agentTokens.revokedAt),
          sql`${agentTokens.grantId} in (select id from ${agentGrants} where client_id = ${clientId})`,
        ),
      ),
  );
}

/** A person's connected agents, newest first: those not revoked. */
export async function listAgentGrants(db: Db, userId: string): Promise<AgentGrant[]> {
  return run(
    db
      .select()
      .from(agentGrants)
      .where(and(eq(agentGrants.userId, userId), isNull(agentGrants.revokedAt)))
      .orderBy(desc(agentGrants.createdAt)),
  );
}

/** The person revokes one of their agents. Answers whether it was theirs and live. */
export async function revokeAgentGrant(
  db: Db,
  { userId, grantId }: { userId: string; grantId: string },
): Promise<boolean> {
  const [row] = await run(
    db
      .update(agentGrants)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(agentGrants.id, grantId),
          eq(agentGrants.userId, userId),
          isNull(agentGrants.revokedAt),
        ),
      )
      .returning({ id: agentGrants.id }),
  );
  return Boolean(row);
}

async function revokeGrant(db: Db, grantId: string): Promise<void> {
  await run(
    db
      .update(agentGrants)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(agentGrants.id, grantId), isNull(agentGrants.revokedAt))),
  );
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
