import {
  cancelQuestions,
  claimEvents,
  createQuestion,
  getDesignHead,
  getRunnerContext,
  markEventsDelivered,
  type RunnerContext,
  recordTurnUsage,
  reportRunnerState,
} from "@ponzu/db";
import type {
  AckResponse,
  ClaimResponse,
  CompleteResponse,
  GitCredentialResponse,
  QuestionResponse,
  RunnerEvent,
  RunnerSession,
  StateResponse,
  ThreadResponse,
  UploadResponse,
  UsageResponse,
  WithdrawResponse,
} from "@ponzu/runner/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { LeasedRunner } from "../auth/actor.ts";
import type { Deps } from "../deps/index.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { credentialOf, gitTarget } from "../runner/git-credential.ts";
import {
  Ack,
  Claim,
  Complete,
  GitCredential,
  Question,
  State,
  Thread,
  Upload,
  Usage,
  Withdraw,
} from "../runner/protocol.ts";
import { startRunnerSession } from "../runner/session.ts";
import { writeRunnerThread } from "../runner/thread.ts";
import { completeUploads, presignUploads } from "../uploads/uploads.ts";

/*
 * The API's side of the runner protocol (docs/cloud.md, "The runner protocol"). Every route is
 * a design's runner's, and acts on `actor.designId` and nothing else: no route takes a design
 * id. Every one but the session's carries the lease, which `access.runner` holds to, and every
 * one is safe to send again, as each says.
 */

/** The answers, as the allowlist of what leaves. Their types are the protocol's. */
const Person = z.object({ id: z.string(), name: z.string(), login: z.string().nullable() });
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
});
const ClaimView = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      at: z.string(),
      priority: z.enum(["now", "next", "later"]),
      from: Person.nullable(),
      kind: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  ),
  seq: z.number(),
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

async function headSeq(c: RunnerCall): Promise<number> {
  const head = await getDesignHead(c.var.deps.db, c.var.actor.designId);
  if (!head) throw new ApiError(404, "not_found", "There is no such design.");
  return head.seq;
}

export const runner = new Hono<AppEnv>()
  /**
   * Takes the design's lease: a new runner id, which every later call carries, and whatever
   * held it before is refused from now on. Safe to repeat: the last one wins.
   */
  .post("/session", access.runnerStarting, async (c) => {
    const session = await startRunnerSession(c.var.deps, c.var.actor.designId);
    return c.json(SessionView.parse(session));
  })

  /**
   * The design's events this runner has not been handed, oldest first, and the design's head.
   * An event goes to each runner once, so asking again hands out only what is new.
   */
  .post("/events/claim", access.runner, validate("json", Claim), async (c) => {
    const { db } = c.var.deps;
    const { designId, runnerId } = c.var.actor;
    const [claimed, seq] = await Promise.all([
      claimEvents(db, { designId, runnerId, limit: c.req.valid("json").limit }),
      headSeq(c),
    ]);
    const response: ClaimResponse = {
      events: claimed.map(
        (event) =>
          ({
            id: event.id,
            seq: event.seq,
            at: event.createdAt.toISOString(),
            priority: event.priority,
            from: event.from,
            kind: event.kind,
            payload: event.payload,
          }) as RunnerEvent,
      ),
      seq,
    };
    return c.json(ClaimView.parse(response));
  })

  /**
   * Marks events delivered and keeps the Claude session they went into, in one statement.
   * Those already marked, or another design's, are left alone. Safe to repeat.
   */
  .post("/events/ack", access.runner, validate("json", Ack), async (c) => {
    const { ids, claudeSessionId } = c.req.valid("json");
    const acked = await markEventsDelivered(c.var.deps.db, {
      designId: c.var.actor.designId,
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
    const seq = await reportRunnerState(deps.db, {
      designId: actor.designId,
      now: new Date(deps.clock.now()),
      ...c.req.valid("json"),
    });
    if (seq === null) throw new ApiError(404, "not_found", "There is no such design.");
    return c.json({ seq } satisfies StateResponse);
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
    const token = await deps.gitTokens.get(deps, target);
    return c.json(CredentialView.parse(credentialOf(token)));
  })

  /** GitHub refused the token git was given: the next ask mints a new one. Safe to repeat. */
  .post("/git-credential/erase", access.runner, validate("json", GitCredential), async (c) => {
    c.var.deps.gitTokens.forget(gitTarget(await contextOf(c), c.req.valid("json")));
    return c.body(null, 204);
  })

  /** What each turn used, by model, under the turn's id. Safe to repeat. */
  .post("/usage", access.runner, validate("json", Usage), async (c) => {
    const recorded = await recordTurnUsage(c.var.deps.db, {
      designId: c.var.actor.designId,
      turns: c.req.valid("json").turns.map((turn) => ({
        id: turn.id,
        at: new Date(turn.at),
        models: turn.models.map(({ costUsd, ...usage }) => ({
          ...usage,
          costMicrousd: Math.round(costUsd * 1_000_000),
        })),
      })),
    });
    return c.json({ recorded } satisfies UsageResponse);
  });
