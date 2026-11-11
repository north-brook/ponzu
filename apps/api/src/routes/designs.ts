import {
  type CommittedOp,
  type Doc,
  InvalidOpError,
  MAX_COMMIT_BYTES,
  MAX_NAME_LENGTH,
  newOpId,
  type Op,
  PAGE_ICONS,
  validateCommit,
} from "@ponzu/core";
import {
  AGENT_BLOCKERS,
  AGENT_STATES,
  DESIGN_STATUSES,
  type Design,
  deleteDesign,
  findDesignByCreateKey,
  getDesign,
  getDesignAssetKey,
  getMemberWorkspace,
  getWorkspaceRepo,
  listPresence,
  listRepoPeople,
  listWorkspacePeople,
  markDesignSeen,
  PR_CHECKS,
  PR_STATES,
  readOps,
  removePresence,
  settleDesign,
  touchPresence,
} from "@ponzu/db";
import { MAX_TEXT } from "@ponzu/runner/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { type DesignGrant, requireDesign, requireWorkspace } from "../auth/authorize.ts";
import { canWrite, repoPermission } from "../auth/repo-access.ts";
import { EFFORTS, MODEL_IDS } from "../claude/models.ts";
import type { Deps } from "../deps/index.ts";
import { toCommittedOp } from "../designs/actor.ts";
import { commitPost } from "../designs/commit.ts";
import { startDesign } from "../designs/create.ts";
import { readCurrentDoc } from "../designs/document.ts";
import { reverse } from "../designs/undo.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { forgetCheckpoints } from "../runner/checkpoint.ts";
import { destroySandboxes, retireSandboxes } from "../sandboxes/retire.ts";
import { toPersonView, WorkspacePersonView } from "./workspaces.ts";

/*
 * A design: its row, its document and how it changes (docs/cloud.md, "The document and how it
 * syncs"), who has it open, and how far each person has looked. Every route finds the design
 * through `requireDesign`, which asks GitHub whether the caller may read or steer it.
 */

const Id = z.string().min(1).max(64);
const Params = z.object({ id: Id });
const Name = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const Icon = z.enum(PAGE_ICONS);

/** A design as the apps show it, with where its files are. */
const DesignView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** Null for Scratch. */
  repo: z.object({ id: z.string(), fullName: z.string() }).nullable(),
  ownerId: z.string().nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  branch: z.string().nullable(),
  status: z.enum(DESIGN_STATUSES),
  settledAt: z.date().nullable(),
  seq: z.number(),
  previewSeq: z.number().nullable(),
  agentState: z.enum(AGENT_STATES),
  agentStatus: z.string().nullable(),
  agentArtboards: z.array(z.string()),
  /** Why the agent cannot run now ("connect Claude", "waiting for a machine"), or null. */
  agentBlocker: z.enum(AGENT_BLOCKERS).nullable(),
  needsYouCount: z.number(),
  prNumber: z.number().nullable(),
  prState: z.enum(PR_STATES).nullable(),
  prChecks: z.enum(PR_CHECKS),
  prMergeable: z.boolean().nullable(),
  prAutoMerge: z.boolean(),
  lastActivityAt: z.date(),
  createdAt: z.date(),
  /** What the caller may do: look, or also steer. */
  access: z.enum(["read", "write"]),
  /** The design's files are under here. Knowing it is the permission to read them. */
  assetsUrl: z.string(),
});

function toView(
  { config }: Pick<Deps, "config">,
  design: Design,
  repo: { fullName: string } | null,
  access: DesignGrant["access"],
  assetKey: string,
): z.input<typeof DesignView> {
  return {
    ...design,
    repo: design.repoId && repo ? { id: design.repoId, fullName: repo.fullName } : null,
    access,
    assetsUrl: `${config.assetsUrl}/${assetKey}/`,
  };
}

async function viewOf(
  deps: Pick<Deps, "db" | "config">,
  grant: Pick<DesignGrant, "design" | "repo" | "access">,
) {
  const assetKey = await getDesignAssetKey(deps.db, grant.design.id);
  if (!assetKey) throw new ApiError(404, "not_found", "There is no such design.");
  return DesignView.parse(toView(deps, grant.design, grant.repo, grant.access, assetKey));
}

const CreateBody = z.object({
  workspaceId: Id,
  /** A repo of the workspace the person can push to. Null or left out for Scratch. */
  repoId: Id.nullable().optional(),
  name: Name.optional(),
  /** What the person says first, which sets the agent going and names the design's branch. */
  message: z.object({ text: z.string().trim().min(1).max(MAX_TEXT) }).optional(),
  /** What it runs on; the person's defaults when left out. */
  model: z.enum(MODEL_IDS).optional(),
  effort: z.enum(EFFORTS).optional(),
  /**
   * The app's own id for this create, new for each design it means to make and the same when it
   * sends the create again (a double tap, a retry after a lost answer): it makes one design.
   */
  createKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
});

const PatchBody = z
  .object({ name: Name, icon: Icon.nullable(), settled: z.boolean() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Say what to change.");

/**
 * The body of a commit, checked whole by `validateCommit`: a post that fails it is refused
 * with nothing committed. Each op is checked on its own afterwards.
 */
const CommitBody = z.unknown().transform((body, ctx) => {
  try {
    return validateCommit(body);
  } catch (error) {
    if (!(error instanceof InvalidOpError)) throw error;
    // `ops[3].id` as zod writes a path, `["ops", 3, "id"]`; "body" is the whole of it.
    const path = error.path
      .split(/[.[\]]+/)
      .filter((part) => part && part !== "body")
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    ctx.addIssue({ code: "custom", message: error.problem, path });
    return z.NEVER;
  }
});

/**
 * The most a commit's body may weigh: the replica's 3 MB of ops, and the brackets and commas
 * around them. A body larger than this is refused before it is read.
 */
const MAX_COMMIT_BODY_BYTES = MAX_COMMIT_BYTES + 4096;

/**
 * The most op text one page of `GET /ops` carries, the same as a post, so an answer stays
 * inside the 4.5 MB a Vercel function may send. A page always has at least one op.
 */
const OPS_PAGE_BYTES = MAX_COMMIT_BYTES;

const DocView = z.object({ doc: z.custom<Doc>(), seq: z.number() });
const OpsView = z.object({ ops: z.array(z.custom<CommittedOp>()), seq: z.number() });
const CommitView = z.object({
  committed: z.array(z.custom<CommittedOp>()),
  rejected: z.array(z.object({ id: z.string(), reason: z.string() })),
  seq: z.number(),
});
const ReversalView = z.object({ committed: z.custom<CommittedOp>(), seq: z.number() });

const PresenceBody = z.object({
  /** The page they are on. Left out: only "still here". */
  pageId: Id.nullable().optional(),
});
const PresenceView = z.object({
  /** Who has the design open now, longest here first: the first paint of `design.presence`. */
  present: z.array(
    z.object({
      userId: z.string(),
      githubLogin: z.string(),
      name: z.string().nullable(),
      avatarUrl: z.string().nullable(),
      pageId: z.string().nullable(),
      joinedAt: z.date(),
      seenAt: z.date(),
    }),
  ),
});

/** Who can open a design, as Share lists them: everyone GitHub gives access to its repo. */
const DesignPeopleView = z.object({
  people: z.array(
    WorkspacePersonView.extend({
      /**
       * `owner`: the design is theirs. Otherwise what GitHub lets them do in its repo: `edit`
       * (push) or `view` (read).
       */
      access: z.enum(["owner", "edit", "view"]),
    }),
  ),
});

const SeenBody = z.object({
  seq: z.number().int().min(0).optional(),
  threadSeq: z.number().int().min(0).optional(),
});

export const designs = new Hono<AppEnv>()
  /**
   * Starts a design: in a repo the person can push to, or Scratch, which is theirs alone. It
   * has one empty page and nothing else. With a first message, which is what the composer
   * sends, the message is in its thread and on its way to the agent, and its sandbox is waking,
   * all at once. A `createKey` sent again answers with the design it made the first time (200).
   */
  .post("/", access.user, validate("json", CreateBody), async (c) => {
    const { deps, actor } = c.var;
    const body = c.req.valid("json");
    const { workspaceId, repoId, name = "Untitled", message, createKey } = body;
    if (createKey) {
      const made = await findDesignByCreateKey(deps.db, { ownerId: actor.user.id, createKey });
      if (made) return c.json(await viewOf(deps, await requireDesign(c, made.id, "read")), 200);
    }
    const workspace = await requireWorkspace(c, workspaceId);
    const repo = repoId ? await getWorkspaceRepo(deps.db, { workspaceId, repoId }) : null;
    if (repoId) {
      const permission = repo
        ? await repoPermission(deps, { user: actor.user, repo, installation: workspace })
        : "none";
      if (permission === "none") throw new ApiError(404, "not_found", "There is no such repo.");
      if (!canWrite(permission)) {
        throw new ApiError(403, "forbidden", "Designs need a repo you can push to.");
      }
    }
    const { design, created } = await startDesign(deps, {
      user: actor.user,
      workspaceId,
      repo,
      name,
      ...(message ? { message } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.effort ? { effort: body.effort } : {}),
      ...(createKey ? { createKey } : {}),
    });
    return c.json(await viewOf(deps, { design, repo, access: "write" }), created ? 201 : 200);
  })

  /** What the app's chrome shows about a design, and where its files are. */
  .get("/:id", access.user, validate("param", Params), async (c) => {
    const grant = await requireDesign(c, c.req.valid("param").id, "read");
    return c.json(await viewOf(c.var.deps, grant));
  })

  /**
   * Who can open it, for Share: everyone GitHub gives access to its repo, whether or not they
   * have opened Ponzu, its owner first. Access is GitHub's, so nothing here grants any. A
   * Scratch design is its owner's alone. Someone who reaches the workspace only through repos
   * shared with them sees only themselves, as in the workspace's member list.
   */
  .get("/:id/people", access.user, validate("param", Params), async (c) => {
    const { db } = c.var.deps;
    const { user } = c.var.actor;
    const { design, repo } = await requireDesign(c, c.req.valid("param").id, "read");
    const member = await requireWorkspace(c, design.workspaceId);
    const everyone = repo
      ? await listRepoPeople(db, { workspaceId: design.workspaceId, repoId: repo.id })
      : (await listWorkspacePeople(db, design.workspaceId))
          .filter((person) => person.userId !== null && person.userId === design.ownerId)
          .map((person) => ({ ...person, permission: "admin" as const }));
    const shown =
      member.githubAccess === "collaborator"
        ? everyone.filter((person) => person.userId === user.id)
        : everyone;
    const people = shown
      .map((person) => ({
        ...toPersonView(person),
        access:
          person.userId !== null && person.userId === design.ownerId
            ? ("owner" as const)
            : person.permission === "read"
              ? ("view" as const)
              : ("edit" as const),
      }))
      .toSorted((a, b) => Number(b.access === "owner") - Number(a.access === "owner"));
    return c.json(DesignPeopleView.parse({ people }));
  })

  /**
   * Renames it, changes its icon, or settles or reopens it. The name and icon are the
   * document's, so they change by an op like any other, which every replica and the agent see.
   */
  .patch("/:id", access.user, validate("param", Params), validate("json", PatchBody), async (c) => {
    const { deps, actor } = c.var;
    const grant = await requireDesign(c, c.req.valid("param").id, "write");
    const { name, icon, settled } = c.req.valid("json");
    const ops: Op[] = [];
    if (name !== undefined) ops.push({ op: "file.rename", name });
    if (icon !== undefined) ops.push({ op: "file.icon", icon });
    if (ops.length > 0) {
      const { rejected } = await commitPost(deps, {
        design: grant.design,
        caller: actor,
        posted: [{ id: newOpId(), op: ops.length === 1 ? ops[0] : { op: "batch", ops } }],
      });
      // Both apply to any document, so this is a bug, not a bad request.
      if (rejected.length > 0) throw new Error(`A rename was rejected: ${rejected[0]!.reason}`);
    }
    const design =
      settled === undefined
        ? await getDesign(deps.db, grant.design.id)
        : await settleDesign(deps.db, grant.design.id, {
            settled,
            now: new Date(deps.clock.now()),
          });
    if (!design) throw new ApiError(404, "not_found", "There is no such design.");
    if (settled) {
      // A settled design needs no sandbox; the minute's sweep does this too, for a merge.
      deps.background(
        "retire",
        retireSandboxes(deps, design.id).then((ids) => destroySandboxes(deps, ids)),
      );
    }
    return c.json(await viewOf(deps, { ...grant, design }));
  })

  /** Deletes it with everything that is only its own. Its owner or a workspace admin may. */
  .delete("/:id", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    const { design } = await requireDesign(c, c.req.valid("param").id, "write");
    if (design.ownerId !== actor.user.id) {
      const member = await getMemberWorkspace(deps.db, {
        userId: actor.user.id,
        workspaceId: design.workspaceId,
      });
      if (member?.role !== "admin") {
        throw new ApiError(403, "forbidden", "Only its owner or a workspace admin can delete it.");
      }
    }
    // Its sandboxes first, while the design is there to put their awake time down to.
    const sandboxes = await retireSandboxes(deps, design.id);
    const forget = await forgetCheckpoints(deps, design.id);
    await deleteDesign(deps.db, design.id);
    deps.background("retire", destroySandboxes(deps, sandboxes));
    // Its transcripts and work in progress, which no row knows of any more.
    deps.background("checkpoints_deleted", forget());
    return c.body(null, 204);
  })

  /** The whole document, as of `seq`. */
  .get("/:id/doc", access.userOrRunner, validate("param", Params), async (c) => {
    const { design } = await requireDesign(c, c.req.valid("param").id, "read");
    const current = await readCurrentDoc(c.var.deps, design.id);
    if (!current) throw new ApiError(404, "not_found", "There is no such design.");
    return c.json(DocView.parse({ doc: current.doc, seq: current.seq }));
  })

  /**
   * The ops after `after`, oldest first, and the design's seq. When the last op is below the
   * seq, ask again from there. 410 when the log no longer keeps the ops right after `after`.
   */
  .get(
    "/:id/ops",
    access.userOrRunner,
    validate("param", Params),
    validate("query", z.object({ after: z.coerce.number().int().min(0) })),
    async (c) => {
      const { design } = await requireDesign(c, c.req.valid("param").id, "read");
      const read = await readOps(c.var.deps.db, {
        designId: design.id,
        after: c.req.valid("query").after,
        maxBytes: OPS_PAGE_BYTES,
      });
      if (!read) throw new ApiError(404, "not_found", "There is no such design.");
      if (read.kind === "too_old") {
        throw new ApiError(410, "ops_pruned", "Those ops are no longer kept. Fetch the document.");
      }
      return c.json(OpsView.parse({ ops: read.ops.map(toCommittedOp), seq: read.seq }));
    },
  )

  /**
   * Commits ops, each on its own: a rejected op changes nothing and the rest go on. An id
   * posted again answers with its original result.
   */
  .post(
    "/:id/ops",
    access.userOrRunner,
    bodyLimit({ maxSize: MAX_COMMIT_BODY_BYTES }),
    validate("param", Params),
    validate("json", CommitBody),
    async (c) => {
      const { design } = await requireDesign(c, c.req.valid("param").id, "write");
      const result = await commitPost(c.var.deps, {
        design,
        caller: c.var.actor,
        posted: c.req.valid("json"),
      });
      return c.json(CommitView.parse(result));
    },
  )

  /** Takes back the newest op by the caller or the agent that has not been taken back. */
  .post("/:id/undo", access.userOrRunner, validate("param", Params), async (c) => {
    const { design } = await requireDesign(c, c.req.valid("param").id, "write");
    const result = await reverse(c.var.deps, { design, caller: c.var.actor, kind: "undo" });
    return c.json(ReversalView.parse(result));
  })

  /** Takes back the caller's newest undo, unless they or the agent have changed something since. */
  .post("/:id/redo", access.userOrRunner, validate("param", Params), async (c) => {
    const { design } = await requireDesign(c, c.req.valid("param").id, "write");
    const result = await reverse(c.var.deps, { design, caller: c.var.actor, kind: "redo" });
    return c.json(ReversalView.parse(result));
  })

  /**
   * Says the person has the design open, and on which page. Clients send it on opening and
   * every 30 seconds after; 75 seconds without one and they are gone.
   */
  .put(
    "/:id/presence",
    access.user,
    validate("param", Params),
    validate("json", PresenceBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { design } = await requireDesign(c, c.req.valid("param").id, "read");
      const now = new Date(deps.clock.now());
      const { pageId } = c.req.valid("json");
      await touchPresence(deps.db, { designId: design.id, userId: actor.user.id, pageId, now });
      const present = await listPresence(deps.db, { designId: design.id, now });
      return c.json(PresenceView.parse({ present }));
    },
  )

  /**
   * Says the person closed the design, so they leave at once. It takes away only their own
   * row, so it asks nothing of the design: one just deleted, or no longer theirs to open, is left
   * as quietly as any other.
   */
  .delete("/:id/presence", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    await removePresence(deps.db, { designId: c.req.valid("param").id, userId: actor.user.id });
    return c.body(null, 204);
  })

  /**
   * Records how far the person has looked: the design's seq and the thread's, as they saw
   * them. Left out, the design's seq is now's. It never moves back, nor past what there is.
   */
  .post(
    "/:id/seen",
    access.user,
    validate("param", Params),
    validate("json", SeenBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { design } = await requireDesign(c, c.req.valid("param").id, "read");
      const { seq = design.seq, threadSeq } = c.req.valid("json");
      await markDesignSeen(deps.db, { userId: actor.user.id, designId: design.id, seq, threadSeq });
      return c.body(null, 204);
    },
  );
