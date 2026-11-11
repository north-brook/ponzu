import type { ThreadItem } from "@ponzu/runner/protocol";
import type { InferRequestType, InferResponseType } from "hono/client";
import type { Rpc } from "./rpc.ts";

/*
 * The thread's routes for people (docs/cloud.md, "People's side"), as the apps name their
 * shapes, inferred from the API's own routes (`AppType`) so the two cannot drift. The API's
 * schema for an item says only that its payload is an object; which payload goes with which
 * kind is the runner protocol's `ThreadItem`, so items are read as that.
 */

type DesignRoutes = Rpc["v1"]["designs"][":id"];

/** What a person sends the agent. `attachments` are `ref`s from `api.designs.upload`. */
export type SendMessageBody = InferRequestType<DesignRoutes["messages"]["$post"]>["json"];

/** An answer to a question row (`design.questions`), as the runner's `answer` event carries it. */
export type AnswerBody = InferRequestType<
  DesignRoutes["questions"][":questionId"]["answer"]["$post"]
>["json"];

type ThreadAnswer = InferResponseType<DesignRoutes["thread"]["$get"], 200>;

/** Thread items before `before`, oldest first, for scrolling back past what is live. */
export type ThreadPage = Omit<ThreadAnswer, "items"> & { items: ThreadItem[] };

/**
 * `asset`: a file for the canvas (a picture dropped on a board). `attachment`: one sent with a
 * message. Both are images kept as files of the design, which the API treats alike.
 */
export type UploadPurpose = "asset" | "attachment";

/** An item as the API sent it, read by its kind. */
export function asThreadItem(item: ThreadAnswer["items"][number]): ThreadItem {
  return item as ThreadItem;
}
