import { isId } from "@ponzu/db";
import {
  type AckRequest,
  CLAIM_LIMIT,
  type ClaimRequest,
  type CompleteRequest,
  type GitCredentialRequest,
  MAX_TEXT,
  MAX_THREAD_WRITE,
  type QuestionRequest,
  type RunErrorCode,
  type StateRequest,
  type ThreadRequest,
  type UploadRequest,
  type UsageRequest,
  type WithdrawRequest,
} from "@ponzu/runner/protocol";
import { z } from "zod";

/*
 * The bodies of the runner's calls (docs/cloud.md, "The runner protocol"), checked. Each schema
 * is declared as the protocol's own type, `@ponzu/runner/protocol`, so a change to the protocol
 * that the API does not take up fails to compile here. Agent text is clipped rather than
 * refused (`MAX_TEXT`): the runner sends what the agent wrote, and a write it cannot fix is
 * dropped. Unknown keys are dropped too: a schema is the allowlist of what reaches a row.
 */

/** Text from the sandbox: at most `max` characters, cut with an ellipsis past that. */
const text = (max = MAX_TEXT) =>
  z.string().transform((value) => (value.length > max ? `${value.slice(0, max - 1)}…` : value));

/** An id the runner chose, as `newId(prefix)` makes them. */
const chosenId = (prefix: "ti" | "q" | "clm") =>
  z
    .string()
    .refine((value) => isId(prefix, value), `Expected an id like ${prefix}_ and 16 characters.`);

const ShortId = z.string().min(1).max(64);
const Artboards = z.array(ShortId).max(200);

export const Claim: z.ZodType<ClaimRequest> = z.object({
  claimId: chosenId("clm"),
  limit: z.number().int().min(1).max(CLAIM_LIMIT).optional(),
});

export const Ack: z.ZodType<AckRequest> = z.object({
  ids: z.array(ShortId).max(CLAIM_LIMIT * 2),
  claudeSessionId: z.string().min(1).max(128).nullable(),
});

const RUN_ERRORS = [
  "clone_failed",
  "claude_auth",
  "claude_limit",
  "model_unavailable",
  "max_turns",
  "turn_failed",
  "agent_exited",
  "message_refused",
  "question_failed",
] as const satisfies RunErrorCode[];

const RunnerNotice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("waking") }),
  z.object({ type: z.literal("resumed") }),
  z.object({ type: z.literal("started") }),
  z.object({
    type: z.literal("question"),
    questionId: chosenId("q"),
    header: text(200),
    text: text(),
  }),
  z.object({ type: z.literal("stopped"), eventId: ShortId }),
  z.object({ type: z.literal("error"), code: z.enum(RUN_ERRORS), message: text(2_000) }),
]);

const ThreadWrite = z.intersection(
  z.object({ id: chosenId("ti"), streaming: z.boolean() }),
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("assistant"), payload: z.object({ text: text() }) }),
    z.object({
      kind: z.literal("tool"),
      payload: z.object({
        label: text(500),
        steps: z.number().int().min(0),
        artboards: Artboards,
      }),
    }),
    z.object({ kind: z.literal("notice"), payload: RunnerNotice }),
  ]),
);

export const Thread: z.ZodType<ThreadRequest, unknown> = z.object({
  items: z
    .array(ThreadWrite)
    .min(1)
    .max(MAX_THREAD_WRITE)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
      message: "Each item is written once a call.",
    }),
});

export const State: z.ZodType<StateRequest, unknown> = z.object({
  state: z.enum(["working", "needs_you", "idle"]),
  status: text(500).nullable(),
  artboards: Artboards,
  claudeSessionId: z.string().min(1).max(128).nullable(),
});

const Option = z.object({ label: text(200), description: text(2_000) });

export const Question: z.ZodType<QuestionRequest, unknown> = z.intersection(
  z.object({ id: chosenId("q") }),
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("question"),
      payload: z.object({
        questions: z
          .array(
            z.object({
              header: text(200),
              question: text(2_000),
              options: z.array(Option).max(8),
              multiSelect: z.boolean(),
            }),
          )
          .min(1)
          .max(4),
      }),
    }),
    z.object({ kind: z.literal("plan"), payload: z.object({ plan: text() }) }),
    z.object({
      kind: z.literal("permission"),
      payload: z.object({ tool: text(200), title: text(500), description: text(2_000).nullable() }),
    }),
  ]),
);

export const Withdraw: z.ZodType<WithdrawRequest> = z.object({
  ids: z.array(ShortId).max(CLAIM_LIMIT),
});

/** The most files one upload call carries. */
export const MAX_UPLOAD_FILES = 16;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "Expected a SHA-256 in lowercase hex.");

export const UploadFile = z.object({
  name: z.string().min(1).max(200),
  contentType: z.string().min(1).max(200),
  size: z.number().int().min(0),
  sha256: Sha256,
});

export const Upload: z.ZodType<UploadRequest> = z.object({
  files: z
    .array(UploadFile.extend({ purpose: z.enum(["asset", "export", "preview"]) }))
    .min(1)
    .max(MAX_UPLOAD_FILES),
});

export const Complete: z.ZodType<CompleteRequest> = z.object({
  ids: z.array(ShortId).min(1).max(MAX_UPLOAD_FILES),
  seq: z.number().int().min(0).optional(),
});

export const GitCredential: z.ZodType<GitCredentialRequest> = z.object({
  protocol: z.string().max(32),
  host: z.string().max(256),
  path: z.string().max(512),
});

const Count = z.number().int().min(0);

export const Usage: z.ZodType<UsageRequest> = z.object({
  turns: z
    .array(
      z.object({
        // Claude Code's uuid for the turn's result.
        id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
        claudeSessionId: z.string().min(1).max(128),
        at: z.iso.datetime({ offset: true }),
        models: z
          .array(
            z.object({
              model: z.string().min(1).max(128),
              inputTokens: Count,
              outputTokens: Count,
              cacheReadTokens: Count,
              cacheWriteTokens: Count,
              costUsd: z.number().min(0),
            }),
          )
          .max(16),
      }),
    )
    .max(CLAIM_LIMIT),
});
