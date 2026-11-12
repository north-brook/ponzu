import { isId } from "@ponzu/db";
import {
  type AckRequest,
  type CheckpointRequest,
  CLAIM_LIMIT,
  type ClaimRequest,
  type CompleteRequest,
  GIT_REPORTS,
  type GitCredentialRequest,
  type GitReport as GitReportRequest,
  MAX_PULL_REQUEST_SUMMARY,
  MAX_SECRET_NAME,
  MAX_STEP_TEXT,
  MAX_TEXT,
  MAX_THREAD_WRITE,
  MAX_TURN_GROUPS,
  type ModelsReport,
  type PullRequestSummaryRequest,
  type QuestionRequest,
  type RestoredReport,
  type RunErrorCode,
  type TurnRecord as RunnerTurnRecord,
  SECRET_NAME,
  type SecretRequest,
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
  "push_failed",
  "elicitation_unsupported",
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

const StepCount = z.number().int().min(0).max(1_000_000);

/**
 * A turn's record: phrases and counts, bounded so a turn of any length stays a few kilobytes
 * in a row clients watch live. Steps past `MAX_TURN_GROUPS` with text are refused, not kept.
 */
const TurnRecord: z.ZodType<RunnerTurnRecord> = z.object({
  ended: z.enum(["done", "stopped", "failed"]).nullable(),
  ms: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
  final: chosenId("ti").nullable(),
  boards: StepCount,
  files: StepCount,
  log: z
    .array(
      z.object({
        after: chosenId("ti").nullable(),
        text: text(MAX_STEP_TEXT).nullable(),
        count: StepCount.min(1),
      }),
    )
    // The counted remainder: a group after each message until the runner's record holds this
    // many, then only counts in its last.
    .max(MAX_TURN_GROUPS * 2)
    .refine((log) => log.filter((g) => g.text !== null).length <= MAX_TURN_GROUPS, {
      message: `At most ${MAX_TURN_GROUPS} steps are listed.`,
    }),
});

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
        turn: TurnRecord.optional(),
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

const SessionId = z.string().min(1).max(128);

export const State: z.ZodType<StateRequest, unknown> = z.object({
  state: z.enum(["working", "needs_you", "idle"]),
  status: text(500).nullable(),
  artboards: Artboards,
  claudeSessionId: SessionId.nullable(),
  branch: z
    .object({
      unpushed: z
        .number()
        .int()
        .min(0)
        .max(2 ** 31 - 1),
      error: text(1_000).nullable(),
    })
    .nullable()
    .optional(),
  claudeLimit: z
    .object({
      status: z.enum(["allowed", "allowed_warning", "rejected"]),
      window: text(64).nullable(),
      resetsAt: z.iso.datetime({ offset: true }).nullable(),
      utilization: z.number().min(0).max(100).nullable(),
    })
    .nullable()
    .optional(),
});

const Turn = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);
const UploadId = z.string().min(1).max(64);

export const Checkpoint: z.ZodType<CheckpointRequest> = z.object({
  turn: Turn,
  claudeSessionId: SessionId.nullable(),
  wipCommit: z
    .string()
    .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "Expected a commit's full hash.")
    .nullable(),
  session: UploadId.nullable(),
  workspace: UploadId.nullable(),
  keep: z.object({ session: z.boolean().optional(), workspace: z.boolean().optional() }).optional(),
});

const When = z.iso.datetime({ offset: true });
const BootId = z.string().max(64).nullable();

export const Restored: z.ZodType<RestoredReport> = z.object({
  kind: z.enum(["rollback", "rebuilt"]),
  disk: z.object({ turn: Turn, at: When, bootId: BootId }).nullable(),
  saved: z.object({ turn: Turn, at: When }),
  bootId: BootId,
  bootAt: When.nullable(),
  restored: z.object({ session: z.boolean(), workspace: z.boolean() }),
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
    // The name's own rule (`checkSecretName`) is the route's, which refuses a reserved one by
    // its code. Only the shape is checked here.
    z.object({
      kind: z.literal("secret"),
      payload: z.object({
        name: z.string().regex(SECRET_NAME).max(MAX_SECRET_NAME),
        description: text(2_000).nullable(),
      }),
    }),
    z.object({
      kind: z.literal("handoff"),
      payload: z.object({
        title: text(200),
        url: z
          .string()
          .max(4_000)
          .refine(isWebAddress, "A hand-off's address is an http or https URL."),
        description: text(2_000).nullable(),
      }),
    }),
  ]),
);

/** `POST /v1/runner/secret`. */
export const SecretAsk: z.ZodType<SecretRequest> = z.object({ questionId: chosenId("q") });

/** An http or https URL: the only kind a person's app opens for a hand-off. */
function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

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
    .array(
      UploadFile.extend({
        purpose: z.enum(["asset", "export", "preview", "session", "workspace"]),
      }),
    )
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
  reason: text(500).optional(),
});

/**
 * What the runner saw of git and GitHub, for the log: a known name and a few short scalar
 * fields (`said` is git's own last words, which never carry the token).
 */
export const GitReport: z.ZodType<GitReportRequest, unknown> = z.object({
  name: z.enum(GIT_REPORTS),
  fields: z
    .record(
      z.string().max(64),
      z.union([text(500), z.number(), z.boolean(), z.null()]) as z.ZodType<
        string | number | boolean | null,
        unknown
      >,
    )
    .refine((fields) => Object.keys(fields).length <= 20, "At most 20 fields."),
});

export const PullRequestSummary: z.ZodType<PullRequestSummaryRequest> = z.object({
  summary: text(MAX_PULL_REQUEST_SUMMARY),
});

/**
 * What Claude Code offers the account the runner runs as. Model ids and aliases are refused
 * rather than clipped: a clipped id would be a model that does not exist.
 */
export const Models: z.ZodType<ModelsReport> = z.object({
  claudeCode: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  models: z
    .array(
      z.object({
        value: z.string().min(1).max(200),
        resolvedModel: z.string().min(1).max(200).nullable(),
        displayName: text(200),
        description: text(400),
        efforts: z
          .array(z.enum(["low", "medium", "high", "xhigh", "max"]))
          .max(5)
          .nullable(),
      }),
    )
    .min(1)
    .max(50),
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
        turn: z
          .object({
            startedAt: z.iso.datetime({ offset: true }),
            outcome: z.enum(["completed", "failed", "stopped"]),
            errorCode: z.enum(RUN_ERRORS).nullable(),
            durationMs: Count,
            toolCalls: Count,
            eventId: ShortId.nullable(),
          })
          .optional(),
      }),
    )
    .max(CLAIM_LIMIT),
});
