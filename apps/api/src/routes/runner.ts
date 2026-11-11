import {
  cancelQuestions,
  claimEvents,
  createQuestion,
  getRunnerContext,
  markEventsDelivered,
  type RunnerContext,
  recordTurnUsage,
  reportRunnerState,
} from "@ponzu/db";
import type {
  AckResponse,
  CheckpointResponse,
  ClaimResponse,
  CompleteResponse,
  GitCredentialResponse,
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
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { stableUuid } from "../analytics/analytics.ts";
import { captureForDesign } from "../analytics/design.ts";
import { access } from "../auth/access.ts";
import type { LeasedRunner } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import { CLIENT_HEADER } from "../http/client-version.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { savePullRequestSummary } from "../pull-requests/open.ts";
import { recordRestored, recordRunnerCheckpoint, restoreFor } from "../runner/checkpoint.ts";
import { credentialOf, describeToken, gitTarget } from "../runner/git-credential.ts";
import {
  Ack,
  Checkpoint,
  Claim,
  Complete,
  GitCredential,
  GitReport,
  PullRequestSummary,
  Question,
  Restored,
  State,
  Thread,
  Upload,
  Usage,
  Withdraw,
} from "../runner/protocol.ts";
import { startRunnerSession } from "../runner/session.ts";
import { writeRunnerThread } from "../runner/thread.ts";
import { reportTurns } from "../runner/turns.ts";
import { completeUploads, presignUploads } from "../uploads/uploads.ts";

/*
 * The API's side of the runner protocol (docs/cloud.md, "The runner protocol"). Every route is
 * a design's runner's, and acts on `actor.designId` and nothing else: no route takes a design
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
  design: z.object({ id: z.string(), name: z.string() }),
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

/** The caller's design as its runner works with it. */
async function contextOf(c: RunnerCall): Promise<RunnerContext> {
  const context = await getRunnerContext(c.var.deps.db, c.var.actor.designId);
  if (!context) throw new ApiError(404, "not_found", "There is no such design.");
  return context;
}

export const runner = new Hono<AppEnv>()
  /**
   * Takes the design's lease: a new runner id, which every later call carries, and whatever
   * held it before is refused from now on. Safe to repeat: the last one wins.
   */
  .post("/session", access.runnerStarting, async (c) => {
    const session = await startRunnerSession(
      c.var.deps,
      c.var.actor.designId,
      c.req.header(CLIENT_HEADER) ?? null,
    );
    return c.json(SessionView.parse(session));
  })

  /**
   * The design's events this runner has not been handed, oldest first, and the design's head,
   * from one statement. An event goes to each runner once, so a new claim hands out only what
   * is new. Safe to repeat: the same claim id hands out again what it handed out.
   */
  .post("/events/claim", access.runner, validate("json", Claim), async (c) => {
    const { designId, runnerId } = c.var.actor;
    const { claimId, limit } = c.req.valid("json");
    const claimed = await claimEvents(c.var.deps.db, { designId, runnerId, claimId, limit });
    if (!claimed) throw new ApiError(404, "not_found", "There is no such design.");
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
   * Those already marked, another design's, or never handed to this runner are left alone, and
   * the statement holds to the lease itself. Safe to repeat.
   */
  .post("/events/ack", access.runner, validate("json", Ack), async (c) => {
    const { ids, claudeSessionId } = c.req.valid("json");
    const acked = await markEventsDelivered(c.var.deps.db, {
      designId: c.var.actor.designId,
      runnerId: c.var.actor.runnerId,
      ids,
      claudeSessionId,
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
        c.var.actor.designId,
        c.req.valid("json").items,
      );
      return c.json(ThreadView.parse(written));
    },
  )

  /**
   * What the agent is doing, as the design's head shows it, and the heartbeat. Answers the
   * design's head. Safe to repeat: the last one wins.
   */
  .put("/state", access.runner, validate("json", State), async (c) => {
    const { deps, actor } = c.var;
    const { quiesced, ...report } = c.req.valid("json");
    const answer = await reportRunnerState(deps.db, {
      designId: actor.designId,
      now: new Date(deps.clock.now()),
      ...report,
      quiesced: quiesced ? new Date(quiesced) : null,
    });
    if (answer === null) throw new ApiError(404, "not_found", "There is no such design.");
    // While the sandbox is being stopped, which stop: the runner gets ready and says so.
    return c.json({
      seq: answer.seq,
      sleep: answer.sleep?.toISOString() ?? null,
    } satisfies StateResponse);
  })

  /**
   * Records a checkpoint whose archives were uploaded (purposes `session` and `workspace`), if
   * its turn is above the design's last. Safe to repeat.
   */
  .post("/checkpoint", access.runner, validate("json", Checkpoint), async (c) => {
    const saved = await recordRunnerCheckpoint(c.var.deps, c.var.actor, c.req.valid("json"));
    return c.json({ saved: SavedView.parse(saved) } satisfies CheckpointResponse);
  })

  /** The design's last checkpoint and addresses that read its archives back for ten minutes. */
  .post("/restore", access.runner, async (c) => {
    const restored = await restoreFor(c.var.deps, c.var.actor.designId);
    return c.json(RestoreView.parse(restored));
  })

  /** The runner found its disk behind the last checkpoint and restored from it. Logged. */
  .post("/restored", access.runner, validate("json", Restored), async (c) => {
    const { deps, actor } = c.var;
    const report = c.req.valid("json");
    await recordRestored(deps, actor.designId, report);
    captureForDesign(deps, actor.designId, (workspaceId) =>
      deps.analytics.capture(
        "sandbox restored",
        { design_id: actor.designId, kind: report.kind },
        {
          workspaceId,
          uuid: stableUuid(`${actor.designId}/${report.bootId}/${report.saved.turn}/restored`),
        },
      ),
    );
    return c.body(null, 204);
  })

  /** Raises a question under the id the runner chose. Safe to repeat. */
  .post("/questions", access.runner, validate("json", Question), async (c) => {
    const { id, kind, payload } = c.req.valid("json");
    const question = await createQuestion(c.var.deps.db, {
      designId: c.var.actor.designId,
      id,
      kind,
      payload: { ...payload },
    });
    // Only when this raised it: one raised again after a lost answer was asked once.
    const { deps, actor } = c.var;
    if (question.raised) {
      captureForDesign(deps, actor.designId, (workspaceId) =>
        deps.analytics.capture(
          "question asked",
          { design_id: actor.designId, question_id: question.id, kind },
          { workspaceId },
        ),
      );
    }
    return c.json({ id: question.id, status: question.status } satisfies QuestionResponse);
  })

  /** The run moved on: closes those of these that are still open. Safe to repeat. */
  .post("/questions/withdraw", access.runner, validate("json", Withdraw), async (c) => {
    const withdrawn = await cancelQuestions(c.var.deps.db, {
      designId: c.var.actor.designId,
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
      { designId: c.var.actor.designId, assetKey },
      files,
      null,
    );
    return c.json(UploadView.parse({ files: placed }));
  })

  /** Records the files whose bytes arrived. Safe to repeat; 404 for bytes that never did. */
  .post("/uploads/complete", access.runner, validate("json", Complete), async (c) => {
    const { assetKey, design } = await contextOf(c);
    const { ids, seq } = c.req.valid("json");
    const files = await completeUploads(
      c.var.deps,
      { designId: design.id, assetKey, seq: design.seq },
      ids,
      { userId: null, previewSeq: seq },
    );
    return c.json(CompleteView.parse({ files }));
  })

  /**
   * A one-hour token for the design's repository and nothing else, for git. Reused while it
   * has ten minutes left. Safe to repeat.
   */
  .post("/git-credential", access.runner, validate("json", GitCredential), async (c) => {
    const { deps } = c.var;
    const target = gitTarget(await contextOf(c), c.req.valid("json"));
    const given = await deps.gitTokens.get(deps, target);
    // What went to git, so a push GitHub refuses can be traced to the token it was handed.
    deps.log.info("git_credential", { designId: c.var.actor.designId, ...describeToken(given) });
    return c.json(CredentialView.parse(credentialOf(given.token)));
  })

  /** GitHub refused the token git was given: the next ask mints a new one. Safe to repeat. */
  .post("/git-credential/erase", access.runner, validate("json", GitCredential), async (c) => {
    const ask = c.req.valid("json");
    const forgotten = c.var.deps.gitTokens.forget(gitTarget(await contextOf(c), ask));
    c.var.deps.log.warn("git_credential_erased", {
      designId: c.var.actor.designId,
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
    const line = { ...fields, designId: actor.designId, from: "runner" };
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
    const saved = await savePullRequestSummary(c.var.deps, c.var.actor.designId, summary);
    return c.json(saved satisfies PullRequestSummaryResponse);
  })

  /**
   * What each turn used, by model, under the turn's id, and how it went (analytics). Safe to
   * repeat: a turn's events are captured under ids made from its own, which PostHog keeps once.
   */
  .post("/usage", access.runner, validate("json", Usage), async (c) => {
    const { turns } = c.req.valid("json");
    const recorded = await recordTurnUsage(c.var.deps.db, {
      designId: c.var.actor.designId,
      turns: turns.map((turn) => ({
        id: turn.id,
        at: new Date(turn.at),
        models: turn.models.map(({ costUsd, ...usage }) => ({
          ...usage,
          costMicrousd: Math.round(costUsd * 1_000_000),
        })),
      })),
    });
    // Off the runner's path: the row is what matters to it, and analytics never fails a call.
    c.var.deps.background(
      "turns_reported",
      reportTurns(c.var.deps, c.var.actor.designId, turns, c.req.header(CLIENT_HEADER) ?? null),
    );
    return c.json({ recorded } satisfies UsageResponse);
  });
