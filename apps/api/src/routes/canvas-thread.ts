import {
  answerQuestion,
  appendEvent,
  attachCommentPicture,
  getCanvasAssetKey,
  getComment,
  getQuestion,
  getUploads,
  getUser,
  listAssets,
  listThreadItems,
  postMessage,
  type Question,
  type ThreadItem as StoredItem,
} from "@ponzu/db";
import {
  COMMENT_PICTURE,
  type CommentPicture,
  MAX_TEXT,
  type QuestionBody,
  type ThreadItem,
} from "@ponzu/runner/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { appSession } from "../analytics/scope.ts";
import { access } from "../auth/access.ts";
import { requireCanvas } from "../auth/authorize.ts";
import { personFor } from "../canvases/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { steer } from "../http/gates.ts";
import { validate } from "../http/validate.ts";
import { questionsClosed } from "../notifications/badge.ts";
import { Complete, MAX_UPLOAD_FILES, UploadFile } from "../runner/protocol.ts";
import { requestWake } from "../sandboxes/wake.ts";
import { commentRef, completeUploads, presignUploads } from "../uploads/uploads.ts";

/*
 * People's side of a canvas's thread (docs/cloud.md, "The runner protocol", "Events", "Needs
 * you"): what they say to the agent, their answers to its questions, stopping it, the thread's
 * history, and the images they attach. Reading takes read access to the canvas; everything else
 * steers it and takes write access. Each write that the agent must hear of then asks for the
 * canvas's sandbox (`requestWake`).
 */

const Params = z.object({ id: z.string().min(1).max(64) });
const QuestionParams = Params.extend({ questionId: z.string().min(1).max(64) });

/** A file of the canvas as a message attaches it: what markup calls it. */
const AssetRef = z.string().regex(/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const MAX_ATTACHMENTS = 8;

const MessageBody = z.object({
  text: z.string().trim().min(1).max(MAX_TEXT),
  /** Files of the canvas, uploaded first (`/uploads`), by reference. */
  attachments: z.array(AssetRef).max(MAX_ATTACHMENTS).optional(),
});

const AnswerBody = z.object({
  /** For a `question`: each question's text, to the label chosen or the person's own words. */
  answers: z.record(z.string().max(2_000), z.string().trim().min(1).max(4_000)).optional(),
  /** For a `plan` or a `permission`. */
  approved: z.boolean().optional(),
  note: z.string().trim().max(4_000).optional(),
});

const ThreadQuery = z.object({
  /** Items before this thread seq; the newest when left out. */
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

const UploadBody = z.object({ files: z.array(UploadFile).min(1).max(MAX_UPLOAD_FILES) });
const CompleteBody = Complete.transform(({ ids }) => ({ ids }));

/** A comment by the id of its message (`m_…`, chosen by the person's app). */
const CommentParams = Params.extend({
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});
const PictureBody = z.object({ files: z.array(UploadFile).length(2) });
const PictureView = z.object({
  picture: z.object({
    light: z.string(),
    dark: z.string(),
    width: z.number(),
    height: z.number(),
  }),
});

const Item = z.object({
  id: z.string(),
  seq: z.number(),
  at: z.string(),
  streaming: z.boolean(),
  kind: z.enum(["message", "comment", "assistant", "tool", "notice"]),
  payload: z.record(z.string(), z.unknown()),
});
const ThreadView = z.object({ items: z.array(Item) });
const QuestionView = z.object({
  id: z.string(),
  status: z.enum(["open", "answered", "cancelled"]),
});
/** A question as it stands: once answered, the answer that won and who gave it. */
const StandingQuestionView = QuestionView.extend({
  answer: z
    .object({
      answers: z.record(z.string(), z.string()).optional(),
      approved: z.boolean().optional(),
      note: z.string().optional(),
    })
    .nullable(),
  answeredBy: z.object({ id: z.string(), name: z.string(), login: z.string() }).nullable(),
});
const UploadView = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      put: z.object({ url: z.string(), headers: z.record(z.string(), z.string()) }),
      expiresAt: z.string(),
    }),
  ),
});
const CompleteView = z.object({
  files: z.array(z.object({ id: z.string(), ref: z.string().nullable(), url: z.string() })),
});

/** A thread item as clients read it (`ThreadItem` in the runner protocol). */
function toItem(item: StoredItem): ThreadItem {
  return {
    id: item.id,
    seq: item.seq,
    at: item.createdAt.toISOString(),
    streaming: item.streaming,
    kind: item.kind,
    payload: item.payload,
  } as ThreadItem;
}

/**
 * The refusal of an answer to a question that is no longer open. When someone answered it,
 * `details.answeredBy` says who, so the one who got there second is told by name.
 */
async function closedBy(db: Parameters<typeof getUser>[0], question: Question): Promise<ApiError> {
  const message = "This question is no longer open.";
  const userId = question.status === "answered" ? question.answeredByUserId : null;
  const user = userId ? await getUser(db, userId) : null;
  return new ApiError(
    409,
    "question_closed",
    message,
    user ? { details: { answeredBy: personFor(user) } } : {},
  );
}

/** What the answer event carries beside the question, if it answers a question of this kind. */
function answerOf(question: Question, body: z.infer<typeof AnswerBody>): Record<string, unknown> {
  const asked = { kind: question.kind, payload: question.payload } as QuestionBody;
  if (asked.kind === "question") {
    // Every question that was asked, by its text, and nothing else: an answer closes the
    // question for good, so one left out could never be answered.
    const texts = asked.payload.questions.map((q) => q.question);
    const answers = body.answers ?? {};
    const missing = texts.filter((text) => !Object.hasOwn(answers, text));
    if (missing.length > 0) {
      throw new ApiError(400, "invalid_request", `Answer every question: ${missing.join(" ")}`);
    }
    if (Object.keys(answers).some((text) => !texts.includes(text))) {
      throw new ApiError(400, "invalid_request", "Answer only the questions that were asked.");
    }
    return { answers };
  }
  if (asked.kind === "plan" || asked.kind === "permission") {
    if (body.approved === undefined) {
      throw new ApiError(400, "invalid_request", "Say whether you approve.");
    }
    return { approved: body.approved, ...(body.note ? { note: body.note } : {}) };
  }
  throw new ApiError(400, "invalid_request", "This kind of question is not answered here.");
}

export const canvasThread = new Hono<AppEnv>()
  /**
   * Says something to the agent: the thread shows it at once, and it goes into the run as soon
   * as the runner can take it. Answers the thread item.
   */
  .post(
    "/:id/messages",
    access.user,
    validate("param", Params),
    validate("json", MessageBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
      const { text, attachments: refs = [] } = c.req.valid("json");
      const assets = await listAssets(deps.db, { canvasId: canvas.id, paths: [...new Set(refs)] });
      const byPath = new Map(assets.map((asset) => [asset.path, asset]));
      const missing = refs.find((ref) => !byPath.has(ref));
      if (missing) {
        throw new ApiError(400, "invalid_request", `${missing} is not one of this canvas's files.`);
      }
      const attachments = refs.map((ref) => ({ ref, contentType: byPath.get(ref)!.contentType }));
      const extra = attachments.length > 0 ? { attachments } : {};
      await steer(c, { action: "message", workspaceId: canvas.workspaceId, canvasId: canvas.id });
      const item = await postMessage(deps.db, {
        canvasId: canvas.id,
        userId: actor.user.id,
        item: { text, from: personFor(actor.user), ...extra },
        event: { text, ...extra },
        posthogSessionId: appSession(),
      });
      deps.analytics.capture("message sent", {
        canvas_id: canvas.id,
        first: false,
        characters: text.length,
        attachments: attachments.length,
      });
      await requestWake(deps, canvas.id, "message");
      return c.json(Item.parse(toItem(item)), 201);
    },
  )

  /**
   * Answers one of the agent's questions. The first answer wins; any later one is 409
   * `question_closed`, as is an answer to a question the run has withdrawn.
   */
  .post(
    "/:id/questions/:questionId/answer",
    access.user,
    validate("param", QuestionParams),
    validate("json", AnswerBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { id, questionId } = c.req.valid("param");
      const { canvas } = await requireCanvas(c, id, "write");
      const question = await getQuestion(deps.db, { canvasId: canvas.id, id: questionId });
      if (!question) throw new ApiError(404, "not_found", "There is no such question.");
      if (question.status !== "open") throw await closedBy(deps.db, question);
      const answer = answerOf(question, c.req.valid("json"));
      await steer(c, { action: "answer", workspaceId: canvas.workspaceId, canvasId: canvas.id });
      const answered = await answerQuestion(deps.db, {
        canvasId: canvas.id,
        id: questionId,
        answer,
        userId: actor.user.id,
        posthogSessionId: appSession(),
      });
      if (!answered) {
        const now = await getQuestion(deps.db, { canvasId: canvas.id, id: questionId });
        throw await closedBy(deps.db, now ?? question);
      }
      deps.analytics.capture("question answered", {
        canvas_id: canvas.id,
        question_id: answered.id,
        kind: answered.kind,
      });
      // Off everyone's badge, and read for whoever answered, so their phone is not pinged.
      await questionsClosed(deps, {
        canvasId: canvas.id,
        questionIds: [answered.id],
        answeredBy: actor.user.id,
      });
      await requestWake(deps, canvas.id, "answer");
      return c.json(QuestionView.parse(answered));
    },
  )

  /**
   * One of the agent's questions as it stands. Once answered, the answer that won and who gave
   * it, so someone who was answering it too sees what was chosen and by whom. A secret's value is
   * never kept with its question, so a secret has no answer here.
   */
  .get("/:id/questions/:questionId", access.user, validate("param", QuestionParams), async (c) => {
    const { deps } = c.var;
    const { id, questionId } = c.req.valid("param");
    const { canvas } = await requireCanvas(c, id, "read");
    const question = await getQuestion(deps.db, { canvasId: canvas.id, id: questionId });
    if (!question) throw new ApiError(404, "not_found", "There is no such question.");
    const answered = question.status === "answered";
    const userId = answered ? question.answeredByUserId : null;
    const user = userId ? await getUser(deps.db, userId) : null;
    const given = answered && question.kind !== "secret" ? question.answer : null;
    return c.json(
      StandingQuestionView.parse({
        id: question.id,
        status: question.status,
        answer: given && typeof given === "object" && !Array.isArray(given) ? given : null,
        answeredBy: user ? personFor(user) : null,
      }),
    );
  })

  /** Stops the agent's turn, and whatever was put in behind it. */
  .post("/:id/stop", access.user, validate("param", Params), async (c) => {
    const { deps, actor } = c.var;
    const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
    await appendEvent(deps.db, {
      canvasId: canvas.id,
      kind: "stop",
      priority: "now",
      payload: {},
      userId: actor.user.id,
    });
    deps.analytics.capture("turn stopped", { canvas_id: canvas.id });
    await requestWake(deps, canvas.id, "stop");
    return c.body(null, 204);
  })

  /**
   * The thread, a page at a time, oldest first: the newest items, or those before `before`.
   * The live query `canvas.thread` keeps it current from there.
   */
  .get(
    "/:id/thread",
    access.user,
    validate("param", Params),
    validate("query", ThreadQuery),
    async (c) => {
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "read");
      const { before, limit } = c.req.valid("query");
      const items = await listThreadItems(c.var.deps.db, { canvasId: canvas.id, before, limit });
      return c.json(ThreadView.parse({ items: items.map(toItem) }));
    },
  )

  /**
   * Addresses that take exactly the declared images for ten minutes, for an attachment or a
   * pasted picture. Each is kept under its own name with a few characters added, so it never
   * replaces one of the canvas's files.
   */
  .post(
    "/:id/uploads",
    access.user,
    validate("param", Params),
    validate("json", UploadBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
      const assetKey = await getCanvasAssetKey(deps.db, canvas.id);
      if (!assetKey) throw new ApiError(404, "not_found", "There is no such canvas.");
      const files = c.req.valid("json").files.map((file) => ({ ...file, kind: "image" as const }));
      const placed = await presignUploads(
        deps,
        { canvasId: canvas.id, assetKey },
        files,
        actor.user.id,
      );
      return c.json(UploadView.parse({ files: placed }));
    },
  )

  /** Records the images whose bytes arrived, as files of the canvas: `ref` is `assets/<name>`. */
  .post(
    "/:id/uploads/complete",
    access.user,
    validate("param", Params),
    validate("json", CompleteBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { canvas } = await requireCanvas(c, c.req.valid("param").id, "write");
      const assetKey = await getCanvasAssetKey(deps.db, canvas.id);
      if (!assetKey) throw new ApiError(404, "not_found", "There is no such canvas.");
      const target = { canvasId: canvas.id, assetKey, seq: canvas.seq };
      const files = await completeUploads(deps, target, c.req.valid("json").ids, {
        userId: actor.user.id,
      });
      return c.json(CompleteView.parse({ files }));
    },
  )

  /**
   * Addresses for the picture of where the person left a comment (`light.webp` and
   * `dark.webp`), which their app draws as the comment is sent. Asked for whether or not the
   * comment's op has been committed yet.
   */
  .post(
    "/:id/comments/:messageId/picture",
    access.user,
    validate("param", CommentParams),
    validate("json", PictureBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { id, messageId } = c.req.valid("param");
      const { canvas } = await requireCanvas(c, id, "write");
      const assetKey = await getCanvasAssetKey(deps.db, canvas.id);
      if (!assetKey) throw new ApiError(404, "not_found", "There is no such canvas.");
      const files = c.req
        .valid("json")
        .files.map((file) => ({ ...file, kind: "comment" as const, comment: messageId }));
      const placed = await presignUploads(
        deps,
        { canvasId: canvas.id, assetKey },
        files,
        actor.user.id,
      );
      return c.json(UploadView.parse({ files: placed }));
    },
  )

  /**
   * Gives the person's comment the picture whose bytes arrived, both themes at once, and
   * answers the picture it has: the first it was given, as a photo sent stays sent. 404
   * `not_found` while the comment itself is not in the thread (its op not committed yet): ask
   * again once it is. The files wait under `staging/` until then and are copied to where they
   * are served from only for a comment that exists and has no picture yet, so a picture that
   * is never attached is never served.
   */
  .post(
    "/:id/comments/:messageId/picture/complete",
    access.user,
    validate("param", CommentParams),
    validate("json", CompleteBody),
    async (c) => {
      const { deps, actor } = c.var;
      const { id, messageId } = c.req.valid("param");
      const { ids } = c.req.valid("json");
      const { canvas } = await requireCanvas(c, id, "write");
      const assetKey = await getCanvasAssetKey(deps.db, canvas.id);
      if (!assetKey) throw new ApiError(404, "not_found", "There is no such canvas.");
      const who = { canvasId: canvas.id, messageId, userId: actor.user.id };
      const comment = await getComment(deps.db, who);
      if (!comment) throw new ApiError(404, "not_found", "There is no such comment of yours.");
      const had = (comment.payload as { picture?: CommentPicture }).picture;
      if (had) return c.json(PictureView.parse({ picture: had }));

      // Both files are this comment's, one of each theme, before either is copied anywhere.
      const uploads = await getUploads(deps.db, { canvasId: canvas.id, ids });
      pictureOf(
        messageId,
        uploads
          .filter((row) => row.userId === actor.user.id && row.purpose === "comment")
          .map((row) => ({ ref: commentRef(row.name) })),
        ids,
      );
      const target = { canvasId: canvas.id, assetKey, seq: canvas.seq };
      const files = await completeUploads(deps, target, ids, { userId: actor.user.id });
      const picture = pictureOf(messageId, files, ids);
      const item = await attachCommentPicture(deps.db, { ...who, picture: { ...picture } });
      if (!item) throw new ApiError(404, "not_found", "There is no such comment of yours.");
      const kept = (item.payload as { picture?: CommentPicture }).picture ?? picture;
      if (kept.light !== picture.light) {
        // Another of the person's windows attached its picture first: this one is no one's.
        deps.background(
          "comment_picture_unkept",
          Promise.all(
            [picture.light, picture.dark].map((ref) => deps.storage.delete(`${assetKey}/${ref}`)),
          ),
        );
      }
      return c.json(PictureView.parse({ picture: kept }));
    },
  );

/**
 * A comment's picture from its two files, the light and the dark, each a picture of this
 * comment's; refused when they are anything else.
 */
function pictureOf(
  messageId: string,
  files: { ref: string | null }[],
  ids: string[],
): CommentPicture {
  const of = (theme: "light" | "dark") => {
    const found = files.filter(({ ref }) => ref?.startsWith(`comments/${messageId}-${theme}-`));
    return found.length === 1 ? found[0]!.ref! : null;
  };
  const light = of("light");
  const dark = of("dark");
  if (!light || !dark || files.length !== 2 || new Set(ids).size !== 2) {
    throw new ApiError(
      400,
      "invalid_request",
      "A comment's picture is its light.webp and its dark.webp, uploaded for that comment.",
    );
  }
  return { light, dark, width: COMMENT_PICTURE.width, height: COMMENT_PICTURE.height };
}
