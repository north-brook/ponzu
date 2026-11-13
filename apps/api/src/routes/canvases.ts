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
  CANVAS_STATUSES,
  type Canvas,
  findCanvasByCreateKey,
  focusedPresence,
  getCanvas,
  getCanvasAssetKey,
  getMemberWorkspace,
  getSandbox,
  getWorkspaceRepo,
  listPresence,
  listRepoPeople,
  listWorkspacePeople,
  markCanvasSeen,
  markNotificationsRead,
  PR_CHECKS,
  PR_STATES,
  randomString,
  readOps,
  removePresence,
  settleCanvas,
  takeOverCanvas,
  touchPresence,
} from "@ponzu/db";
import { MAX_TEXT, type Notice } from "@ponzu/runner/protocol";
import { Hono, type TypedResponse } from "hono";
import { bodyLimit } from "hono/body-limit";
import { stream } from "hono/streaming";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { type CanvasGrant, requireCanvas, requireWorkspace } from "../auth/authorize.ts";
import { canWrite, repoPermission } from "../auth/repo-access.ts";
import { toCommittedOp } from "../canvases/actor.ts";
import { rotateAssetKey } from "../canvases/asset-key.ts";
import { commitPost } from "../canvases/commit.ts";
import { startCanvas } from "../canvases/create.ts";
import { readCurrentDoc } from "../canvases/document.ts";
import { endDrive } from "../canvases/drive.ts";
import { deleteCanvasAndFiles } from "../canvases/files.ts";
import { reverse } from "../canvases/undo.ts";
import { EFFORTS } from "../claude/models.ts";
import type { Deps } from "../deps/index.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { steer } from "../http/gates.ts";
import { validate } from "../http/validate.ts";
import { isLooking } from "../notifications/plan.ts";
import { forgetCheckpoints } from "../runner/checkpoint.ts";
import { finishRetire, holdForRetire, retire } from "../sandboxes/retire.ts";
import { putToSleep } from "../sandboxes/stop.ts";
import { startWake } from "../sandboxes/wake.ts";
import { toPersonView, WorkspacePersonView } from "./workspaces.ts";

/*
 * A canvas: its row, its document and how it changes (docs/cloud.md, "The document and how it
 * syncs"), who has it open, and how far each person has looked. Every route finds the canvas
 * through `requireCanvas`, which asks GitHub whether the caller may read or steer it.
 */

const Id = z.string().min(1).max(64);
const Params = z.object({ id: Id });
const Name = z.string().trim().min(1).max(MAX_NAME_LENGTH);
const Icon = z.enum(PAGE_ICONS);

/** A canvas as the apps show it, with where its files are. */
const CanvasView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** Null for Scratch. */
  repo: z.object({ id: z.string(), fullName: z.string() }).nullable(),
  ownerId: z.string().nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  branch: z.string().nullable(),
  status: z.enum(CANVAS_STATUSES),
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
  /** The canvas's files are under here. Knowing it is the permission to read them. */
  assetsUrl: z.string(),
  /** When its file links were last reset; null while they never were. */
  assetKeyRotatedAt: z.date().nullable(),
});

function toView(
  { config }: Pick<Deps, "config">,
  canvas: Canvas,
  repo: { fullName: string } | null,
  access: CanvasGrant["access"],
  assetKey: string,
): z.input<typeof CanvasView> {
  return {
    ...canvas,
    repo: canvas.repoId && repo ? { id: canvas.repoId, fullName: repo.fullName } : null,
    access,
    assetsUrl: `${config.assetsUrl}/${assetKey}/`,
  };
}

async function viewOf(
  deps: Pick<Deps, "db" | "config">,
  grant: Pick<CanvasGrant, "canvas" | "repo" | "access">,
) {
  const assetKey = await getCanvasAssetKey(deps.db, grant.canvas.id);
  if (!assetKey) throw new ApiError(404, "not_found", "There is no such canvas.");
  return CanvasView.parse(toView(deps, grant.canvas, grant.repo, grant.access, assetKey));
}

/**
 * What only a canvas's owner or an admin of its workspace may do: delete it, reset its file
 * links. 403 `forbidden` for anyone else, saying `what` they may not do.
 */
async function requireOwnerOrAdmin(
  deps: Pick<Deps, "db">,
  canvas: Pick<Canvas, "ownerId" | "workspaceId">,
  userId: string,
  what: string,
): Promise<void> {
  if (canvas.ownerId === userId) return;
  const member = await getMemberWorkspace(deps.db, { userId, workspaceId: canvas.workspaceId });
  if (member?.role !== "admin") {
    throw new ApiError(403, "forbidden", `Only its owner or a workspace admin can ${what}.`);
  }
}

const CreateBody = z.object({
  workspaceId: Id,
  /** A repo of the workspace the person can push to. Null or left out for Scratch. */
  repoId: Id.nullable().optional(),
  name: Name.optional(),
  /** What the person says first, which sets the agent going and names the canvas's branch. */
  message: z.object({ text: z.string().trim().min(1).max(MAX_TEXT) }).optional(),
  /**
   * What it runs on, one of the models the person's Claude account offers (400
   * `model_not_offered` otherwise); the person's defaults when left out.
   */
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(EFFORTS).optional(),
  /**
   * The app's own id for this create, new for each canvas it means to make and the same when it
   * sends the create again (a double tap, a retry after a lost answer): it makes one canvas.
   */
  createKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  /**
   * Where the first message came from, for analytics only: one of the composer's ideas, or
   * the person's own words (the default).
   */
  source: z.enum(["idea", "prompt"]).optional(),
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

/**
 * What `GET /doc` answers. It is not parsed on the way out: the document is the API's own,
 * built by applyOp from checkpoints and ops it wrote, and parsing a canvas of many MB on every
 * read buys nothing. The route test parses the answer instead.
 */
type DocView = { doc: Doc; seq: number };

/** How much of `GET /doc`'s JSON text each write of its stream carries. */
export const DOC_SLICE_BYTES = 256 * 1024;
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
  /**
   * Whether their window is focused and showing this canvas now. Nobody is pinged about a canvas
   * they are looking at. Left out, it stays as it was.
   */
  focused: z.boolean().optional(),
});
const PresenceView = z.object({
  /** Who has the canvas open now, longest here first: the first paint of `canvas.presence`. */
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

/** Who can open a canvas, as Share lists them: everyone GitHub gives access to its repo. */
const CanvasPeopleView = z.object({
  people: z.array(
    WorkspacePersonView.extend({
      /**
       * `owner`: the canvas is theirs. Otherwise what GitHub lets them do in its repo: `edit`
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

export const canvases = new Hono<AppEnv>()
  /**
   * Starts a canvas: in a repo the person can push to, or Scratch, which is theirs alone. It
   * has one empty page and nothing else. With a first message, which is what the composer
   * sends, the message is in its thread and on its way to the agent, and its sandbox is waking,
   * all at once. A `createKey` sent again answers with the canvas it made the first time (200).
   */
  .post("/", access.user, validate("json", CreateBody), async (c) => {
    const { deps, actor } = c.var;
    const body = c.req.valid("json");
    const { workspaceId, repoId, name = "Untitled", message, createKey } = body;
    if (createKey) {
      const made = await findCanvasByCreateKey(deps.db, { ownerId: actor.user.id, createKey });
      if (made) return c.json(await viewOf(deps, await requireCanvas(c, made.id, "read")), 200);
    }
    const workspace = await requireWorkspace(c, workspaceId);
    const repo = repoId ? await getWorkspaceRepo(deps.db, { workspaceId, repoId }) : null;
    if (repoId) {
      const permission = repo
        ? await repoPermission(deps, { user: actor.user, repo, installation: workspace })
        : "none";
      if (permission === "none") throw new ApiError(404, "not_found", "There is no such repo.");
      if (!canWrite(permission)) {
        throw new ApiError(403, "forbidden", "Canvases need a repo you can push to.");
      }
    }
    // Asked of every create, so that a rate limit counts them all; only one with a first
    // message steers the agent, and the gates that care (billing) let the rest through.
    await steer(c, {
      action: "create",
      workspaceId: workspace.id,
      canvasId: null,
      withMessage: message !== undefined,
    });
    const { canvas, created } = await startCanvas(deps, {
      user: actor.user,
      workspaceId,
      repo,
      name,
      ...(message ? { message } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.effort ? { effort: body.effort } : {}),
      ...(createKey ? { createKey } : {}),
    });
    if (created) {
      deps.analytics.capture("canvas created", {
        canvas_id: canvas.id,
        source: repo ? (body.source ?? "prompt") : "scratch",
        with_message: message !== undefined,
        model: canvas.model,
        effort: canvas.effort,
      });
      if (message) {
        deps.analytics.capture("message sent", {
          canvas_id: canvas.id,
          first: true,
          characters: message.text.length,
          attachments: 0,
        });
      }
    }
    return c.json(await viewOf(deps, { canvas, repo, access: "write" }), created ? 201 : 200);
  })

  /** What the app's chrome shows about a canvas, and where its files are. */
  .get("/:id", access.user, validate("param", Params), async (c) => {
    const grant = await requireCanvas(c, c.req.valid("param").id, "read");
    return c.json(await viewOf(c.var.deps, grant));
  })

  /**
   * Who can open it, for Share: everyone GitHub gives access to its repo, whether or not they
   * have opened Ponzu, its owner first. Access is GitHub's, so nothing here grants any. A
   * Scratch canvas is its owner's alone. Only whom GitHub would show this person: someone who
   * can only read the repo is not shown its outside collaborators, and someone who reaches the
   * workspace only through repos shared with them sees only themselves.
   */
  .get("/:id/people", access.user, validate("param", Params), async (c) => {
    const { db } = c.var.deps;
    const { user } = c.var.actor;
    const { canvas, repo } = await requireCanvas(c, c.req.valid("param").id, "read");
    await requireWorkspace(c, canvas.workspaceId);
    // Who this person is shown is chosen in the query, as GitHub would show them a repo's
    // people: its outside collaborators only to an owner or someone who can push to it.
    const viewer = { workspaceId: canvas.workspaceId, viewerUserId: user.id };
    const shown = repo
      ? await listRepoPeople(db, { ...viewer, repoId: repo.id })
      : (await listWorkspacePeople(db, viewer))
          .filter((person) => person.userId !== null && person.userId === canvas.ownerId)
          .map((person) => ({ ...person, permission: "admin" as const }));
    const people = shown
      .map((person) => ({
        ...toPersonView(person),
        access:
          person.userId !== null && person.userId === canvas.ownerId
            ? ("owner" as const)
            : person.permission === "read"
              ? ("view" as const)
              : ("edit" as const),
      }))
      .toSorted((a, b) => Number(b.access === "owner") - Number(a.access === "owner"));
    return c.json(CanvasPeopleView.parse({ people }));
  })

  /**
   * Renames it, changes its icon, or settles or reopens it. The name and icon are the
   * document's, so they change by an op like any other, which every replica and the agent see.
   */
  .patch("/:id", access.user, validate("param", Params), validate("json", PatchBody), async (c) => {
    const { deps, actor } = c.var;
    const grant = await requireCanvas(c, c.req.valid("param").id, "write");
    const { name, icon, settled } = c.req.valid("json");
    const ops: Op[] = [];
    if (name !== undefined) ops.push({ op: "file.rename", name });
    if (icon !== undefined) ops.push({ op: "file.icon", icon });
    if (ops.length > 0) {
      const { rejected } = await commitPost(deps, {
        canvas: grant.canvas,
        caller: actor,
        posted: [{ id: newOpId(), op: ops.length === 1 ? ops[0] : { op: "batch", ops } }],
      });
      // Both apply to any document, so this is a bug, not a bad request.
      if (rejected.length > 0) throw new Error(`A rename was rejected: ${rejected[0]!.reason}`);
    }
    const canvas =
      settled === undefined
        ? await getCanvas(deps.db, grant.canvas.id)
        : await settleCanvas(deps.db, grant.canvas.id, {
            settled,
            now: new Date(deps.clock.now()),
          });
    if (!canvas) throw new ApiError(404, "not_found", "There is no such canvas.");
    if (settled !== undefined && settled !== (grant.canvas.settledAt !== null)) {
      deps.analytics.capture(settled ? "canvas settled" : "canvas reopened", {
        canvas_id: canvas.id,
      });
    }
    if (settled) {
      // A settled canvas needs no sandbox; the minute's sweep does this too, for a merge. The
      // row is held until its sandbox is deleted, so a reopen meanwhile waits for it.
      deps.background("retire", retire(deps, canvas.id));
    }
    return c.json(await viewOf(deps, { ...grant, canvas }));
  })

  /** Deletes it with everything that is only its own. Its owner or a workspace admin may. */
  .delete("/:id", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
    await requireOwnerOrAdmin(deps, canvas, actor.user.id, "delete it");
    // Its sandbox's row first, while the canvas is there to put its awake time down to.
    const retiring = await holdForRetire(deps, canvas.id);
    const forget = await forgetCheckpoints(deps, canvas.id);
    // The row and its files: the job that deletes them is recorded as the row goes, and runs now.
    // A delete that lost a race with another finds no row, records nothing and counts nothing:
    // the canvas is gone, as asked.
    if (await deleteCanvasAndFiles(deps, canvas.id)) {
      deps.analytics.capture("canvas deleted", {
        canvas_id: canvas.id,
        by_owner: canvas.ownerId === actor.user.id,
      });
    }
    // The row went with the canvas; its id never comes back, so the delete at Vercel follows.
    deps.background("retire", finishRetire(deps, canvas.id, retiring));
    // Its transcripts and work in progress, which no row knows of any more.
    deps.background("checkpoints_deleted", forget());
    return c.body(null, 204);
  })

  /**
   * Resets the canvas's file links (docs/cloud.md, "Assets and previews"): its files move under a
   * new asset key, and links to the old one stop working once the old key's files are deleted, a
   * quarter of an hour later. Its owner or a workspace admin may, as for a delete. Answers the
   * canvas as `GET` does, with its new `assetsUrl`; everyone else's app sees the head's
   * `assetKeyRotatedAt` move and asks for it. Two resets at once make one: the second answers
   * the canvas as the first left it.
   */
  .post("/:id/asset-key/rotate", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    const grant = await requireCanvas(c, c.req.valid("param").id, "write");
    await requireOwnerOrAdmin(deps, grant.canvas, actor.user.id, "reset its file links");
    const rotation = await rotateAssetKey(deps, grant.canvas.id);
    const canvas = rotation === "missing" ? null : await getCanvas(deps.db, grant.canvas.id);
    if (!canvas) throw new ApiError(404, "not_found", "There is no such canvas.");
    if (rotation === "rotated") {
      deps.analytics.capture("canvas file links reset", {
        canvas_id: canvas.id,
        by_owner: canvas.ownerId === actor.user.id,
      });
    }
    return c.json(await viewOf(deps, { ...grant, canvas }));
  })

  /**
   * Takes over a canvas whose owner left the workspace or deleted their account, so that it runs
   * on the caller's Claude from now on (docs/cloud.md, "Deleting an account"). Anyone who can
   * change it and has Claude connected may; no other canvas is anyone else's to take, since a
   * canvas never switches accounts while its owner is there. The canvas becomes theirs, a wait
   * on the last owner's Claude is lifted and the thread says who took it, in one statement; then
   * it wakes if its feed holds work no runner took. A runner started afterwards carries the new
   * owner's credential and resumes the same Claude session.
   *
   * 409 `not_ownerless` when its owner is a member of its workspace (they came back, or a
   * teammate took it first); 409 `claude_not_connected` when the caller has no Claude that
   * could run it.
   */
  .post("/:id/take-over", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    const { user } = actor;
    const grant = await requireCanvas(c, c.req.valid("param").id, "write");
    const { canvas } = grant;
    const notice: Notice = {
      type: "owner_changed",
      by: { id: user.id, name: user.name ?? user.githubLogin, login: user.githubLogin },
    };
    const result = await takeOverCanvas(deps.db, {
      canvasId: canvas.id,
      userId: user.id,
      // Not a runner's shape (`ti_` and sixteen letters and digits): no sandbox can write it.
      noticeId: `ti_owner-${randomString(16)}`,
      notice: { ...notice },
      now: new Date(deps.clock.now()),
    });
    if (!result) throw new ApiError(404, "not_found", "There is no such canvas.");
    if (result.outcome === "not_ownerless") {
      // Its owner came back while its head still said they had left: it runs on their Claude
      // again, so what waited for it goes in now.
      if (result.lifted && result.pending) {
        deps.background("wake", startWake(deps, canvas.id, "owner_back"));
      }
      throw new ApiError(
        409,
        "not_ownerless",
        "Its owner is in the workspace, so it runs on their Claude. Only a canvas whose owner left can be taken over.",
      );
    }
    if (result.outcome === "claude_not_connected") {
      throw new ApiError(
        409,
        "claude_not_connected",
        "Connect your Claude to take it over: a canvas runs on its owner's Claude.",
      );
    }
    deps.log.info("canvas_taken_over", {
      canvasId: canvas.id,
      by: user.id,
      from: canvas.ownerId,
      woke: result.pending,
    });
    deps.analytics.capture("canvas taken over", { canvas_id: canvas.id, woke: result.pending });
    // A sandbox still awake was started on the last owner's credential, and the sweep would no
    // longer stop it: the canvas now runs on a member's Claude, so it looks well. It is put to
    // sleep here, and the pending rule then wakes it on the taker's. Asleep, it wakes when work
    // is owed, as when Claude is connected.
    const sandbox = await getSandbox(deps.db, canvas.id);
    if (sandbox?.state === "awake") {
      deps.background(
        "take_over",
        putToSleep(deps, sandbox, "owner_left").then(() => {}),
      );
    } else if (result.pending) {
      deps.background("wake", startWake(deps, canvas.id, "take_over"));
    }
    const taken = await getCanvas(deps.db, canvas.id);
    if (!taken) throw new ApiError(404, "not_found", "There is no such canvas.");
    return c.json(await viewOf(deps, { ...grant, canvas: taken }));
  })

  /**
   * The whole document, as of `seq`, streamed: the JSON text of `{ doc, seq }` in slices of
   * `DOC_SLICE_BYTES`. A Vercel function may send at most 4.5 MB in one answer, but the limit
   * does not apply to a streamed one, so a canvas past that is still read whole. The function
   * holds the document and its JSON text in memory, so memory is what bounds it now. A client
   * reads it with `response.json()` as before. Whatever can refuse (access, a missing canvas) is
   * decided before the first byte, so a refusal is still the one error body.
   */
  .get("/:id/doc", access.userOrRunner, validate("param", Params), async (c) => {
    const { canvas } = await requireCanvas(c, c.req.valid("param").id, "read");
    const current = await readCurrentDoc(c.var.deps, canvas.id);
    if (!current) throw new ApiError(404, "not_found", "There is no such canvas.");
    const view: DocView = { doc: current.doc, seq: current.seq };
    const body = new TextEncoder().encode(JSON.stringify(view));
    c.header("content-type", "application/json; charset=UTF-8");
    const streamed = stream(c, async (out) => {
      for (let at = 0; at < body.byteLength && !out.aborted; at += DOC_SLICE_BYTES) {
        await out.write(body.subarray(at, at + DOC_SLICE_BYTES));
      }
    });
    // A stream is untyped to Hono's client; this one is the JSON of a DocView, so say so, and
    // `api.canvases.doc` keeps its type.
    return streamed as typeof streamed & TypedResponse<DocView, 200, "json">;
  })

  /**
   * The ops after `after`, oldest first, and the canvas's seq. When the last op is below the
   * seq, ask again from there. 410 when the log no longer keeps the ops right after `after`.
   */
  .get(
    "/:id/ops",
    access.userOrRunner,
    validate("param", Params),
    validate("query", z.object({ after: z.coerce.number().int().min(0) })),
    async (c) => {
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "read");
      const read = await readOps(c.var.deps.db, {
        canvasId: canvas.id,
        after: c.req.valid("query").after,
        maxBytes: OPS_PAGE_BYTES,
      });
      if (!read) throw new ApiError(404, "not_found", "There is no such canvas.");
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
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
      const result = await commitPost(c.var.deps, {
        canvas,
        caller: c.var.actor,
        posted: c.req.valid("json"),
      });
      return c.json(CommitView.parse(result));
    },
  )

  /** Takes back the newest op by the caller or the agent that has not been taken back. */
  .post("/:id/undo", access.userOrRunner, validate("param", Params), async (c) => {
    const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
    const result = await reverse(c.var.deps, { canvas, caller: c.var.actor, kind: "undo" });
    return c.json(ReversalView.parse(result));
  })

  /** Takes back the caller's newest undo, unless they or the agent have changed something since. */
  .post("/:id/redo", access.userOrRunner, validate("param", Params), async (c) => {
    const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
    const result = await reverse(c.var.deps, { canvas, caller: c.var.actor, kind: "redo" });
    return c.json(ReversalView.parse(result));
  })

  /**
   * Says the person has the canvas open, and on which page. Clients send it on opening and
   * every 30 seconds after; 75 seconds without one and they are gone.
   */
  .put(
    "/:id/presence",
    access.user,
    validate("param", Params),
    validate("json", PresenceBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "read");
      const now = new Date(deps.clock.now());
      const { pageId, focused } = c.req.valid("json");
      await touchPresence(deps.db, {
        canvasId: canvas.id,
        userId: actor.user.id,
        pageId,
        focused,
        now,
      });
      const present = await listPresence(deps.db, { canvasId: canvas.id, now });
      return c.json(PresenceView.parse({ present }));
    },
  )

  /**
   * Says the person closed the canvas, so they leave at once. It takes away only their own
   * row, so it asks nothing of the canvas: one just deleted, or no longer theirs to open, is left
   * as quietly as any other.
   */
  /**
   * Take the canvas back from the person's own agent driving it (docs/cloud.md, "Driving a
   * canvas"): its lease ends, the thread says who took it back, and Ponzu's agent takes up what
   * people sent meanwhile. Anyone who may steer the canvas may. 204 whether or not anyone drove it.
   */
  .delete("/:id/driver", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
    // An agent lets go with its own `release_canvas`, which names its grant.
    const ended = await endDrive(
      { ...deps, log: c.var.log },
      {
        canvasId: canvas.id,
        how: actor.agent ? "let_go" : "taken_back",
        by: actor.agent ? null : actor.user,
        ...(actor.agent ? { grantId: actor.agent.grantId } : {}),
      },
    );
    if (ended)
      deps.analytics.capture("canvas taken back", {
        canvas_id: canvas.id,
        by_agent: Boolean(actor.agent),
      });
    return c.body(null, 204);
  })

  .delete("/:id/presence", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    await removePresence(deps.db, { canvasId: c.req.valid("param").id, userId: actor.user.id });
    return c.body(null, 204);
  })

  /**
   * Records how far the person has looked: the canvas's seq and the thread's, as they saw
   * them. Left out, the canvas's seq is now's. It never moves back, nor past what there is.
   * When their presence says they are looking at it (focused within the last 75 seconds),
   * whatever Ponzu told them about the canvas until now is read too (`via: seen`): no ping
   * about it is still to come, and no banner stays. Without that, it reads nothing: an app sends
   * this whenever the canvas or its thread moves on screen, even in a window left open in the
   * background, and a question the agent raised then must still reach the person.
   */
  .post(
    "/:id/seen",
    access.user,
    validate("param", Params),
    validate("json", SeenBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "read");
      const { seq = canvas.seq, threadSeq } = c.req.valid("json");
      const userId = actor.user.id;
      const now = new Date(deps.clock.now());
      const [, focused] = await Promise.all([
        markCanvasSeen(deps.db, { userId, canvasId: canvas.id, seq, threadSeq }),
        focusedPresence(deps.db, { canvasId: canvas.id, userIds: [userId], now }),
      ]);
      if (isLooking(focused.get(userId) ?? null, now)) {
        await markNotificationsRead(deps.db, { userId, canvasId: canvas.id, now, via: "seen" });
      }
      return c.body(null, 204);
    },
  );
