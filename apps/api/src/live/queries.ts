import { CANVAS_HEAD_COLUMNS } from "@ponzu/db";
import { z } from "zod";
import type { Actor, UserActor } from "../auth/actor.ts";
import { requireCanvas, requireWorkspace } from "../auth/authorize.ts";
import { refreshWorkspaceRepoAccess } from "../auth/repo-access.ts";
import type { Deps } from "../deps/index.ts";
import { ApiError } from "../http/errors.ts";

/*
 * Every live query a client may subscribe to, and the only SQL that is ever sealed
 * (docs/cloud.md, "Realtime"). Neon Realtime has no row-level security, so each query's SQL
 * is its access control: `authorize` decides whether the caller may watch, and the values it
 * answers with are bound as parameters, never written into the text.
 *
 * What Realtime needs of them, from the spike that tried it:
 * - Plain filters and joins only, so a change arrives as a delta. No ORDER BY, LIMIT,
 *   aggregates, DISTINCT, subqueries or CTEs (each re-sends the whole result on every change),
 *   and no `now()` (refused). Clients sort, and drop presence older than 75 seconds by
 *   `seen_at` themselves; the sweeper deletes it later.
 * - Every table has a primary key.
 * - Small rows: never a canvas's content, never an `encrypted_…` column or an asset key. A row
 *   is sent whole on every change, and one over 4 MiB ends the subscription.
 * - A `bigint` arrives as a string (`seq` and the rest): decode before comparing.
 */

type LiveContext = {
  var: { deps: Pick<Deps, "db" | "github" | "clock" | "vault" | "log">; actor: Actor };
};

export interface LiveQueryDefinition<Args extends z.ZodType = z.ZodType> {
  args: Args;
  /**
   * The values `sql` binds, in order, if the caller may watch with these arguments; otherwise
   * it throws the same 404 or 403 the matching route would.
   */
  authorize(c: LiveContext, args: z.output<Args>): Promise<string[]>;
  /** Constant text. Everything that varies is a `$n` parameter. */
  sql: string;
}

const define = <Args extends z.ZodType>(query: LiveQueryDefinition<Args>) => query;

const Id = z.string().min(1).max(64);
const ForCanvas = z.object({ canvasId: Id });

/** A query about the person themselves or their workspaces is not a runner's to watch. */
function person({ var: { actor } }: LiveContext): UserActor {
  if (actor.kind !== "user") {
    throw new ApiError(403, "forbidden", "Only a signed-in person can watch this.");
  }
  return actor;
}

/** Anyone who may open the canvas, its runner included. */
async function canvasReader(c: LiveContext, { canvasId }: { canvasId: string }) {
  await requireCanvas(c, canvasId, "read");
  return [canvasId];
}

export const LIVE_QUERIES = {
  /** The person's own row, their settings and their Claude account's state. */
  me: define({
    args: z.object({}),
    authorize: async (c) => [person(c).user.id],
    sql: `select u.id, u.github_login, u.name, u.email, u.avatar_url,
                 u.default_agent, u.default_model, u.default_effort,
                 u.ping_needs_you, u.ping_replies, u.ping_pr_ready, u.ping_teammate_comments,
                 u.email_digest, u.share_usage, u.onboarding_where_at, u.onboarding_iphone_at,
                 a.id as claude_account_id, a.kind as claude_account_kind,
                 a.status as claude_account_status, a.plan_label as claude_plan_label,
                 a.key_hint as claude_key_hint, a.connected_at as claude_connected_at,
                 a.expires_at as claude_expires_at, a.limited_until as claude_limited_until
            from users u
            left join claude_accounts a on a.user_id = u.id
           where u.id = $1`,
  }),

  /**
   * The person's inbox: what Ponzu told them that they have not read, and every needs-you whose
   * question is still open, read or not (the badge counts those). The Mac shows its banners and
   * its dock badge from it. A row leaves once it is read and, for a needs-you, resolved; the
   * sweep reads unread rows three days old, so the result stays small. The filter is the
   * predicate of `notifications_inbox_idx`, word for word, so Postgres reads it from that index.
   * Ids, a canvas's name and Ponzu's own sentences only: never anything a person or the agent
   * wrote.
   */
  "me.notifications": define({
    args: z.object({}),
    authorize: async (c) => [person(c).user.id],
    sql: `select n.id, n.kind, n.workspace_id, n.canvas_id, n.title, n.subtitle, n.body, n.link,
                 n.count, n.muted, n.read_at, n.resolved_at, n.created_at, n.updated_at
            from notifications n
           where n.user_id = $1
             and (n.read_at is null or (n.kind = 'needs_you' and n.resolved_at is null))`,
  }),

  /**
   * The sidebar: a workspace's canvases and how far the person has looked at each. Joined
   * through membership, so a member who is dropped sees the rows go at once, and through
   * `repo_access`, so a canvas shows only to people GitHub lets read its repo, and goes as soon
   * as an answer says they no longer can. Each renewal brings those answers up to the minute.
   * A Scratch canvas is its owner's alone.
   */
  "workspace.canvases": define({
    args: z.object({ workspaceId: Id }),
    authorize: async (c, { workspaceId }) => {
      const actor = person(c);
      const workspace = await requireWorkspace({ var: { deps: c.var.deps, actor } }, workspaceId);
      await refreshWorkspaceRepoAccess(c.var.deps, { user: actor.user, workspace });
      return [actor.user.id, workspaceId];
    },
    sql: `select d.id, d.workspace_id, d.repo_id, r.full_name as repo_full_name, d.owner_id,
                 d.name, d.icon, d.branch, d.status, d.settled_at, d.seq, d.preview_seq,
                 d.agent_state, d.agent_status, d.agent_blocker, d.needs_you_count,
                 d.pr_number, d.pr_state, d.pr_checks, d.last_activity_at, d.created_at,
                 d.asset_key_rotated_at, dr.seen_seq, dr.seen_thread_seq
            from canvases d
            join memberships m on m.workspace_id = d.workspace_id and m.user_id = $1
            left join repos r on r.id = d.repo_id
            left join repo_access ra on ra.repo_id = d.repo_id and ra.user_id = $1
            left join canvas_reads dr on dr.canvas_id = d.id and dr.user_id = $1
           where d.workspace_id = $2
             and (ra.permission in ('admin', 'write', 'read')
                  or (d.repo_id is null and d.owner_id = $1))`,
  }),

  /** A canvas's head: when `seq` moves, fetch the ops after your own from the API. */
  "canvas.head": define({
    args: ForCanvas,
    authorize: canvasReader,
    sql: `select ${CANVAS_HEAD_COLUMNS.map((column) => `d.${column}`).join(", ")},
                 d.agent_blocker, d.agent_blocked_until, s.state as sandbox_state
            from canvases d
            left join sandboxes s on s.canvas_id = d.id
           where d.id = $1`,
  }),

  /** The agent thread. Agent text that is still streaming is updated in place. */
  "canvas.thread": define({
    args: ForCanvas,
    authorize: canvasReader,
    sql: `select id, canvas_id, seq, kind, user_id, payload, streaming, created_at, updated_at
            from thread_items
           where canvas_id = $1`,
  }),

  /** What the agent is waiting on a person for. An answered one leaves the result. */
  "canvas.questions": define({
    args: ForCanvas,
    authorize: canvasReader,
    sql: `select id, canvas_id, seq, kind, payload, status, created_at
            from questions
           where canvas_id = $1 and status = 'open'`,
  }),

  /** Who has the canvas open, with their name and picture. Drop rows whose `seen_at` is 75 seconds old. */
  "canvas.presence": define({
    args: ForCanvas,
    authorize: canvasReader,
    sql: `select p.canvas_id, p.user_id, p.page_id, p.joined_at, p.seen_at,
                 u.github_login, u.name, u.avatar_url
            from presence p
            join users u on u.id = p.user_id
           where p.canvas_id = $1`,
  }),
} satisfies Record<string, LiveQueryDefinition>;

export type LiveQueryName = keyof typeof LIVE_QUERIES;
