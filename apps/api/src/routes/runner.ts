import {
  cancelQuestions,
  claimEvents,
  createQuestion,
  getRunnerContext,
  markEventsDelivered,
  noteRunnerSaid,
  type RunnerContext,
  recordTurnUsage,
  reportRunnerState,
  takeSecretAnswer,
} from "@ponzu/db";
import type {
  AckResponse,
  CheckpointResponse,
  ClaimResponse,
  CompleteResponse,
  GitCredentialResponse,
  ModelsResponse,
  PullRequestSummaryResponse,
  QuestionResponse,
  RestoreResponse,
  RunnerEvent,
  RunnerSession,
  SavedPoint,
  StateResponse,
  ThreadResponse,
  UploadResponse,
  UsageResponse,
  WithdrawResponse,
} from "@ponzu/runner/protocol";
import {
  checkSecretName,
  reservedSecretReason,
  SECRET_DELIVERY_MS,
  type SecretResponse,
} from "@ponzu/runner/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { stableUuid } from "../analytics/analytics.ts";
import { captureForCanvas } from "../analytics/canvas.ts";
import { access } from "../auth/access.ts";
import type { LeasedRunner } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import { secretBinding } from "../environments/secrets.ts";
import { CLIENT_HEADER } from "../http/client-version.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { savePullRequestSummary } from "../pull-requests/open.ts";
import { recordRestored, recordRunnerCheckpoint, restoreFor } from "../runner/checkpoint.ts";
import { credentialOf, describeToken, gitTarget } from "../runner/git-credential.ts";
import { recordReportedModels } from "../runner/models.ts";
import {
  Ack,
  Checkpoint,
  Claim,
  Complete,
  GitCredential,
  GitReport,
  Models,
  PullRequestSummary,
  Question,
  Restored,
  SecretAsk,
  State,
  Thread,
  Upload,
  Usage,
  Withdraw,
} from "../runner/protocol.ts";
import { startRunnerSession } from "../runner/session.ts";
import { writeRunnerThread } from "../runner/thread.ts";
import { reportTurns } from "../runner/turns.ts";
import { claimableKinds } from "../sandboxes/gates.ts";
import { completeUploads, presignUploads } from "../uploads/uploads.ts";

/*
 * The API's side of the runner protocol (docs/cloud.md, "The runner protocol"). Every route is
 * a canvas's runner's, and acts on `actor.canvasId` and nothing else: no route takes a canvas
 * id. Every one but the session's carries the lease, which `access.runner` holds to, and every
 * one is safe to send again, as each says.
 */

/** The answers, as the allowlist of what leaves. Their types are the protocol's. */
const Person = z.object({ id: z.string(), name: z.string(), login: z.string().nullable() });
const SavedView: z.ZodType<SavedPoint> = z.object({
  turn: z.number(),
  at: z.string(),
  claudeSessionId: z.string().nullable(),
  wipCommit: z.string().nullable(),
  session: z.boolean(),
  workspace: z.boolean(),
});
const SessionView: z.ZodType<RunnerSession> = z.object({
  runnerId: z.string(),
  canvas: z.object({ id: z.string(), name: z.string() }),
  repo: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }).nullable(),
  branch: z.string().nullable(),
  claudeSessionId: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
  author: z.object({ name: z.string(), email: z.string() }),
  committer: z.object({ name: z.string(), email: z.string() }),
  assetBase: z.string(),
  link: z.string(),
  theme: z.enum(["light", "dark"]).nullable(),
  openQuestions: z.array(z.string()),
  seq: z.number(),
  saved: SavedView.nullable(),
  workspaceId: z.string(),
  analytics: z.object({ key: z.string(), host: z.string(), content: z.boolean() }).nullable(),
  models: z
    .object({
      claudeCode: z.string(),
      at: z.string(),
      models: z.array(
        z.object({
          value: z.string(),
          resolvedModel: z.string().nullable(),
          displayName: z.string(),
          description: z.string(),
          efforts: z.array(z.enum(["low", "medium", "high", "xhigh", "max"])).nullable(),
        }),
      ),
    })
    .nullable(),
});
const Archive = z.object({ url: z.string(), size: z.number(), sha256: z.string() });
const RestoreView: z.ZodType<RestoreResponse> = z.object({
  saved: SavedView.nullable(),
  session: Archive.nullable(),
  workspace: Archive.nullable(),
});
const ClaimView = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      at: z.string(),
      priority: z.enum(["now", "next", "later"]),
      from: Person.nullable(),
      posthogSessionId: z.string().nullable(),
      kind: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
  seq: z.number(),
  pullRequest: z
    .object({ number: z.number(), state: z.enum(["draft", "open", "merged", "closed"]) })
    .nullable(),
});
const ThreadView: z.ZodType<ThreadResponse> = z.object({
  items: z.array(z.object({ id: z.string(), seq: z.number(), streaming: z.boolean() })),
});
const UploadView: z.ZodType<UploadResponse> = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      put: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }),
      expiresAt: z.string(),
    }),
  ),
});
const CompleteView: z.ZodType<CompleteResponse> = z.object({
  files: z.array(z.object({ id: z.string(), ref: z.string().nullable(), url: z.string() })),
});
const CredentialView: z.ZodType<GitCredentialResponse> = z.object({
  username: z.string(),
  password: z.string(),
  expiresAt: z.string(),
});

/** Thread writes carry agent text: 32 items of up to 32,000 characters, and the JSON around them. */
const MAX_THREAD_BODY_BYTES = 4 * 1024 * 1024;

/** A runner route's context, as far as these need it. */
type RunnerCall = { var: { deps: Pick<Deps, "db">; actor: LeasedRunner } };

/** The caller's canvas as its runner works with it. */
async function contextOf(c: RunnerCall): Promise<RunnerContext> {
  const context = await getRunnerContext(c.var.deps.db, c.var.actor.canvasId);
  if (!context) throw new ApiError(404, "not_found", "There is no such canvas.");
  return context;
}

export const runner = new Hono<AppEnv>()
  /**
   * The runner bundle this API serves, which `ponzu-start` fetches when the hash it was started
   * with (`PONZU_RUNNER_BUNDLE`) is not on the sandbox's disk yet, and checks. Before the lease:
   * the runner is not running yet. The same bytes for every runner of this build.
   */
  .get("/bundle", access.runnerStarting, (c) => {
    const bundle = c.var.deps.runnerBundle();
    const body = Buffer.from(bundle.tgz, "base64");
    return c.body(body, 200, {
      "content-type": "application/gzip",
      "content-length": String(body.byteLength),
      "x-ponzu-bundle-sha256": bundle.sha256,
      "cache-control": "private, max-age=31536000, immutable",
    });
  })

  /**
   * Takes the canvas's lease: a new runner id, which every later call carries, and whatever
   * held it before is refused from now on. Safe to repeat: the last one wins.
   */
  .post("/session", access.runnerStarting, async (c) => {
    const session = await startRunnerSession(
      c.var.deps,
      c.var.actor.canvasId,
      c.req.header(CLIENT_HEADER) ?? null,
    );
    return c.json(SessionView.parse(session));
  })

  /**
   * The canvas's events this runner has not been handed, oldest first, and the canvas's head,
   * from one statement. An event goes to each runner once, so a new claim hands out only what
   * is new. Safe to repeat: the same claim id hands out again what it handed out. Only the
   * kinds `claimableKinds` allows now go out; the rest stay in the feed for a later claim.
   */
  .post("/events/claim", access.runner, validate("json", Claim), async (c) => {
    const { canvasId, runnerId } = c.var.actor;
    const { claimId, limit } = c.req.valid("json");
    const { deps } = c.var;
    const now = new Date(deps.clock.now());
    const kinds = await claimableKinds(deps, { canvasId });
    const claimed = await claimEvents(deps.db, { canvasId, runnerId, claimId, limit, now, kinds });
    if (!claimed) throw new ApiError(404, "not_found", "There is no such canvas.");
    const response: ClaimResponse = {
      events: claimed.events.map(
        (event) =>
          ({
            id: event.id,
            seq: event.seq,
            at: event.createdAt.toISOString(),
            priority: event.priority,
            from: event.from,
            posthogSessionId: event.posthogSessionId,
            kind: event.kind,
            payload: event.payload,
          }) as RunnerEvent,
      ),
      seq: claimed.seq,
      pullRequest: claimed.pullRequest,
    };
    return c.json(ClaimView.parse(response));
  })

  /**
   * Marks events delivered and keeps the Claude session they went into, in one statement.
   * Those already marked, another canvas's, or never handed to this runner are left alone, and
   * the statement holds to the lease itself. Safe to repeat.
   */
  .post("/events/ack", access.runner, validate("json", Ack), async (c) => {
    const { ids, claudeSessionId } = c.req.valid("json");
    const acked = await markEventsDelivered(c.var.deps.db, {
      canvasId: c.var.actor.canvasId,
      runnerId: c.var.actor.runnerId,
      ids,
      claudeSessionId,
      now: new Date(c.var.deps.clock.now()),
    });
    return c.json({ acked } satisfies AckResponse);
  })

  /** Writes thread items by the ids the runner chose. Safe to repeat. */
  .post(
    "/thread",
    access.runner,
    bodyLimit({ maxSize: MAX_THREAD_BODY_BYTES }),
    validate("json", Thread),
    async (c) => {
      const written = await writeRunnerThread(
        c.var.deps,
        c.var.actor.canvasId,
        c.req.valid("json").items,
      );
      return c.json(ThreadView.parse(written));
    },
  )

  /**
   * What the agent is doing, as the canvas's head shows it, and the heartbeat. Answers the
   * canvas's head. Safe to repeat: the last one wins.
   */
  .put("/state", access.runner, validate("json", State), async (c) => {
    const { deps, actor } = c.var;
    const answer = await reportRunnerState(deps.db, {
      canvasId: actor.canvasId,
      now: new Date(deps.clock.now()),
      ...c.req.valid("json"),
    });
    if (answer === null) throw new ApiError(404, "not_found", "There is no such canvas.");
    return c.json({ seq: answer.seq } satisfies StateResponse);
  })

  /**
   * Records a checkpoint whose archives were uploaded (purposes `session` and `workspace`), if
   * its turn is above the canvas's last. Safe to repeat.
   */
  .post("/checkpoint", access.runner, validate("json", Checkpoint), async (c) => {
    const saved = await recordRunnerCheckpoint(c.var.deps, c.var.actor, c.req.valid("json"));
    return c.json({ saved: SavedView.parse(saved) } satisfies CheckpointResponse);
  })

  /** The canvas's last checkpoint and addresses that read its archives back for ten minutes. */
  .post("/restore", access.runner, async (c) => {
    const restored = await restoreFor(c.var.deps, c.var.actor.canvasId);
    return c.json(RestoreView.parse(restored));
  })

  /** The runner found its disk behind the last checkpoint and restored from it. Logged. */
  .post("/restored", access.runner, validate("json", Restored), async (c) => {
    const { deps, actor } = c.var;
    const report = c.req.valid("json");
    await recordRestored(deps, actor.canvasId, report);
    captureForCanvas(deps, actor.canvasId, (workspaceId) =>
      deps.analytics.capture(
        "sandbox restored",
        { canvas_id: actor.canvasId, kind: report.kind },
        {
          workspaceId,
          uuid: stableUuid(`${actor.canvasId}/${report.bootId}/${report.saved.turn}/restored`),
        },
      ),
    );
    return c.body(null, 204);
  })

  /**
   * Raises a question under the id the runner chose. Safe to repeat. A `secret` is asked only
   * for a canvas with a repository (409 `no_repository`), and only under a name a secret may
   * have (400 `secret_name_reserved`).
   */
  .post("/questions", access.runner, validate("json", Question), async (c) => {
    const { id, kind, payload } = c.req.valid("json");
    if (kind === "secret") {
      if (checkSecretName(payload.name) === "reserved") {
        throw new ApiError(400, "secret_name_reserved", reservedSecretReason(payload.name));
      }
      if (!(await contextOf(c)).canvas.repoId) {
        throw new ApiError(
          409,
          "no_repository",
          "A Scratch canvas has no repository to keep a secret.",
        );
      }
    }
    const question = await createQuestion(c.var.deps.db, {
      canvasId: c.var.actor.canvasId,
      id,
      kind,
      payload: { ...payload },
    });
    // Only when this raised it: one raised again after a lost answer was asked once.
    const { deps, actor } = c.var;
    if (question.raised) {
      captureForCanvas(deps, actor.canvasId, (workspaceId) =>
        deps.analytics.capture(
          "question asked",
          { canvas_id: actor.canvasId, question_id: question.id, kind },
          { workspaceId },
        ),
      );
    }
    return c.json({ id: question.id, status: question.status } satisfies QuestionResponse);
  })

  /**
   * The value a person gave for a `secret` question this canvas's runner raised, for the turn
   * that asked: once, within `SECRET_DELIVERY_MS` of the answer, and only to the runner holding
   * the lease (`access.runner`). 404 `not_found` for anything else, alike, so a caller learns
   * nothing of a question it may not have. The same privilege a start's environment gives
   * (`PONZU_REPO_SECRETS`), for one value. Never logged, never in analytics. Not safe to repeat:
   * a second call answers 404, and the next start's environment carries the secret.
   */
  .post("/secret", access.runner, validate("json", SecretAsk), async (c) => {
    const { deps, actor } = c.var;
    const { questionId } = c.req.valid("json");
    const taken = await takeSecretAnswer(deps.db, {
      canvasId: actor.canvasId,
      id: questionId,
      withinMs: SECRET_DELIVERY_MS,
    });
    if (!taken) throw new ApiError(404, "not_found", "There is no secret to hand over.");
    const value = await deps.vault.open(
      taken.encryptedValue,
      secretBinding(taken.repoId, taken.name),
    );
    // Which secret went, never what it is.
    deps.log.info("runner_secret_delivered", { canvasId: actor.canvasId, questionId });
    c.header("cache-control", "no-store");
    return c.json({ name: taken.name, value } satisfies SecretResponse);
  })

  /** The run moved on: closes those of these that are still open. Safe to repeat. */
  .post("/questions/withdraw", access.runner, validate("json", Withdraw), async (c) => {
    const withdrawn = await cancelQuestions(c.var.deps.db, {
      canvasId: c.var.actor.canvasId,
      ids: c.req.valid("json").ids,
    });
    return c.json({ withdrawn } satisfies WithdrawResponse);
  })

  /** Addresses that take exactly the declared bytes for ten minutes. */
  .post("/uploads", access.runner, validate("json", Upload), async (c) => {
    const { assetKey } = await contextOf(c);
    const files = c.req
      .valid("json")
      .files.map(({ purpose, ...file }) => ({ ...file, kind: purpose }));
    const placed = await presignUploads(
      c.var.deps,
      { canvasId: c.var.actor.canvasId, assetKey },
      files,
      null,
    );
    return c.json(UploadView.parse({ files: placed }));
  })

  /** Records the files whose bytes arrived. Safe to repeat; 404 for bytes that never did. */
  .post("/uploads/complete", access.runner, validate("json", Complete), async (c) => {
    const { assetKey, canvas } = await contextOf(c);
    const { ids, seq } = c.req.valid("json");
    const files = await completeUploads(
      c.var.deps,
      { canvasId: canvas.id, assetKey, seq: canvas.seq },
      ids,
      { userId: null, previewSeq: seq },
    );
    return c.json(CompleteView.parse({ files }));
  })

  /**
   * A one-hour token for the canvas's repository and nothing else, for git. Reused while it
   * has ten minutes left. Safe to repeat.
   */
  .post("/git-credential", access.runner, validate("json", GitCredential), async (c) => {
    const { deps } = c.var;
    const target = gitTarget(await contextOf(c), c.req.valid("json"));
    const given = await deps.gitTokens.get(deps, target);
    // What went to git, so a push GitHub refuses can be traced to the token it was handed.
    deps.log.info("git_credential", { canvasId: c.var.actor.canvasId, ...describeToken(given) });
    return c.json(CredentialView.parse(credentialOf(given.token)));
  })

  /** GitHub refused the token git was given: the next ask mints a new one. Safe to repeat. */
  .post("/git-credential/erase", access.runner, validate("json", GitCredential), async (c) => {
    const ask = c.req.valid("json");
    const forgotten = c.var.deps.gitTokens.forget(gitTarget(await contextOf(c), ask));
    c.var.deps.log.warn("git_credential_erased", {
      canvasId: c.var.actor.canvasId,
      fingerprint: forgotten,
      reason: ask.reason ?? null,
    });
    return c.body(null, 204);
  })

  /**
   * What the runner saw of git and GitHub in the sandbox (its checks of a token, its pushes),
   * logged beside `git_credential` so a refused push can be traced from here. Safe to repeat.
   */
  .post("/git-report", access.runner, validate("json", GitReport), async (c) => {
    const { deps, actor } = c.var;
    const { name, fields } = c.req.valid("json");
    const line = { ...fields, canvasId: actor.canvasId, from: "runner" };
    if (name === "git_push" && fields.ok === false) deps.log.warn(name, line);
    else deps.log.info(name, line);
    return c.body(null, 204);
  })

  /**
   * The agent's words on what its branch changes: written into the open pull request's
   * description, or kept until one opens. Safe to repeat: the last one wins.
   */
  .post("/pull-request-summary", access.runner, validate("json", PullRequestSummary), async (c) => {
    const { summary } = c.req.valid("json");
    const saved = await savePullRequestSummary(c.var.deps, c.var.actor.canvasId, summary);
    return c.json(saved satisfies PullRequestSummaryResponse);
  })

  /**
   * What each turn used, by model, under the turn's id, and how it went (analytics). Safe to
   * repeat: a turn's events are captured under ids made from its own, which PostHog keeps once.
   */
  .post("/models", access.runner, validate("json", Models), async (c) => {
    const kept = await recordReportedModels(c.var.deps, c.var.actor.canvasId, c.req.valid("json"));
    return c.json({ kept } satisfies ModelsResponse);
  })

  .post("/usage", access.runner, validate("json", Usage), async (c) => {
    const { turns } = c.req.valid("json");
    const recorded = await recordTurnUsage(c.var.deps.db, {
      canvasId: c.var.actor.canvasId,
      turns: turns.map((turn) => ({
        id: turn.id,
        at: new Date(turn.at),
        models: turn.models.map(({ costUsd, ...usage }) => ({
          ...usage,
          costMicrousd: Math.round(costUsd * 1_000_000),
        })),
      })),
    });
    // A turn that finished answered what it took in, even one that wrote nothing to the thread
    // (docs/cloud.md, "A turn that never came"): nothing delivered before it is owed a turn.
    if (turns.some((turn) => turn.turn)) {
      await noteRunnerSaid(c.var.deps.db, {
        canvasId: c.var.actor.canvasId,
        now: new Date(c.var.deps.clock.now()),
      });
    }
    // Off the runner's path: the row is what matters to it, and analytics never fails a call.
    c.var.deps.background(
      "turns_reported",
      reportTurns(c.var.deps, c.var.actor.canvasId, turns, c.req.header(CLIENT_HEADER) ?? null),
    );
    return c.json({ recorded } satisfies UsageResponse);
  });
