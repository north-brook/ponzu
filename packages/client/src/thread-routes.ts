import type { ThreadItem } from "@ponzu/runner/protocol";

/*
 * PENDING ROUTES. The thread's routes for people are being added to the API alongside this
 * package and are not on `cloud` yet, so their shapes are written here by hand, from
 * docs/cloud.md ("Events", "The thread", "Uploads") and the runner's protocol. When they merge,
 * delete this file and let `api.ts` infer them from `AppType` like every other route.
 *
 *   POST /v1/designs/:id/messages                  SendMessageBody → SentEvent
 *   POST /v1/designs/:id/questions/:qid/answer     AnswerBody      → SentEvent
 *   POST /v1/designs/:id/stop                      {}              → SentEvent
 *   GET  /v1/designs/:id/thread?before=N&limit=M   ThreadPage
 *   POST /v1/designs/:id/uploads                   UploadBody      → UploadTickets
 *   PUT  <put.url>                                 the bytes, with put.headers, no bearer
 *   POST /v1/designs/:id/uploads/complete          { ids }         → UploadedFiles
 */

/** What a person sends the agent. `uploads` are ids from `api.upload`. */
export interface SendMessageBody {
  text: string;
  uploads?: string[];
}

/** An answer to a question row (`design.questions`), as the runner's `answer` event carries it. */
export interface AnswerBody {
  /** For a `question`: the chosen label, or labels joined, per question text. */
  answers?: Record<string, string>;
  /** For a `plan` or a `permission`. */
  approved?: boolean;
  note?: string;
}

/** The event the API added to the design's feed. The thread item arrives through `design.thread`. */
export interface SentEvent {
  id: string;
  seq: number;
}

/** Thread items older than `before`, oldest first, for scrolling back past what is live. */
export interface ThreadPage {
  items: ThreadItem[];
  /** There are older ones still. */
  more: boolean;
}

/** `asset`: a file for the canvas (a picture dropped on a board). `attachment`: one sent with a message. */
export type UploadPurpose = "asset" | "attachment";

export interface UploadBody {
  /** `sha256` is hex: the address takes these bytes and no others. */
  files: {
    purpose: UploadPurpose;
    name: string;
    contentType: string;
    size: number;
    sha256: string;
  }[];
}

export interface UploadTickets {
  files: { id: string; put: { url: string; headers: Record<string, string> }; expiresAt: string }[];
}

export interface UploadedFiles {
  /** An asset's `ref` is `assets/<name>`, as markup uses it; `url` is where it is served. */
  files: { id: string; ref: string | null; url: string }[];
}
