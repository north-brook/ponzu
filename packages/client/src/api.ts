import type { ClientOp, PageIcon } from "@ponzu/core";
import type { ThreadItem } from "@ponzu/runner/protocol";
import { ApiError, networkError } from "./errors.ts";
import type { Randomness } from "./pkce.ts";
import { createRpc, type Fetch } from "./rpc.ts";
import type { Session } from "./session.ts";

/** A file to upload, in the shape both a browser `File` and the phone's picker give. */
export interface UploadFile {
  name: string;
  /** Its media type: `image/png`. */
  type: string;
  bytes: Uint8Array;
}

export interface ApiOptions {
  /** For the upload's checksum. `globalThis.crypto` unless given; see `Randomness`. */
  crypto?: Randomness;
  /** For the upload's PUT to storage, which carries no bearer. */
  fetch?: Fetch;
}

/**
 * One method per thing the apps ask the API (apps/api/README.md has the rules every route
 * follows). Each returns the answer's JSON, typed from the API's own routes, or throws
 * `ApiError`; the session has already acted on what the error means for it.
 */
export function createApi(session: Session, opts: ApiOptions = {}) {
  const rpc = createRpc(session.apiUrl, (input, init) => session.fetch(input, init));
  const v1 = rpc.v1;
  const design = (id: string) => ({ param: { id } });
  const pullRequest = v1.designs[":id"]["pull-request"];

  return {
    /** Everything the app needs at launch: the person, setup progress, their workspaces. */
    me: async () => (await v1.me.$get()).json(),

    github: {
      /** What "Where do you design?" lists, as of the last sync. */
      accounts: async () => (await v1.github.accounts.$get()).json(),
      /** Sync with GitHub now: on coming back to focus, and after the install page. */
      sync: async () => (await v1.github.sync.$post()).json(),
      /** GitHub's install page, with a state good for one return. */
      installLink: async (body: { client: "mac" | "ios"; githubAccountId?: number }) =>
        (await v1.github["install-link"].$post({ json: body })).json(),
    },

    workspaces: {
      list: async () => (await v1.workspaces.$get()).json(),
      /** Its profile, installation, the repos the person reaches, and its members. */
      get: async (id: string) => (await v1.workspaces[":id"].$get(design(id))).json(),
      /** The first paint of a sidebar; `workspace.designs` keeps it fresh. */
      designs: async (id: string) => (await v1.workspaces[":id"].designs.$get(design(id))).json(),
      /** Admins only. 409 `owner_is_admin` or `last_admin` when it cannot be done. */
      setRole: async (id: string, userId: string, role: "admin" | "member") =>
        (
          await v1.workspaces[":id"].members[":userId"].$patch({
            param: { id, userId },
            json: { role },
          })
        ).json(),
    },

    repos: {
      /**
       * The four ideas under the create composer, for a repo the person can read (404
       * otherwise). Asking starts them the first time; `generating` means ask again shortly.
       * `watchRepoIdeas` (ideas.ts) does the asking again; `useRepoIdeas` is it for React.
       */
      ideas: async (id: string) => (await v1.repos[":id"].ideas.$get(design(id))).json(),
    },

    designs: {
      /** In a repo the person can push to, or Scratch (`repoId` left out). */
      create: async (body: { workspaceId: string; repoId?: string | null; name?: string }) =>
        (await v1.designs.$post({ json: body })).json(),
      get: async (id: string) => (await v1.designs[":id"].$get(design(id))).json(),
      rename: async (id: string, body: { name?: string; icon?: PageIcon | null }) =>
        (await v1.designs[":id"].$patch({ ...design(id), json: body })).json(),
      /** Settle it (it is done), or reopen it. */
      settle: async (id: string, settled: boolean) =>
        (await v1.designs[":id"].$patch({ ...design(id), json: { settled } })).json(),
      delete: async (id: string): Promise<void> => {
        await v1.designs[":id"].$delete(design(id));
      },

      doc: async (id: string) => (await v1.designs[":id"].doc.$get(design(id))).json(),
      /** 410 `ops_pruned` when the log no longer keeps the ops after `after`. */
      ops: async (id: string, after: number) =>
        (
          await v1.designs[":id"].ops.$get({ ...design(id), query: { after: String(after) } })
        ).json(),
      commit: async (id: string, ops: ClientOp[]) =>
        (await v1.designs[":id"].ops.$post({ ...design(id), json: { ops } })).json(),
      /** 409 `nothing_to_undo` when nothing is left. */
      undo: async (id: string) => (await v1.designs[":id"].undo.$post(design(id))).json(),
      /** 409 `nothing_to_redo` when nothing is left. */
      redo: async (id: string) => (await v1.designs[":id"].redo.$post(design(id))).json(),

      /** "I have it open", on opening and every 30 seconds: who else does. */
      presence: async (id: string, pageId?: string | null) =>
        (await v1.designs[":id"].presence.$put({ ...design(id), json: { pageId } })).json(),
      /** "I closed it": gone at once rather than after 75 seconds. */
      leave: async (id: string): Promise<void> => {
        await v1.designs[":id"].presence.$delete(design(id));
      },
      /** How far the person has looked, at the design and at its thread. */
      seen: async (id: string, body: { seq?: number; threadSeq?: number } = {}): Promise<void> => {
        await v1.designs[":id"].seen.$post({ ...design(id), json: body });
      },

      /**
       * Says something to the agent, with images uploaded first (`upload`) by their `ref`.
       * Answers the message's thread item, which `design.thread` delivers too.
       */
      sendMessage: async (id: string, body: SendMessageBody): Promise<ThreadItem> =>
        (await (
          await v1.designs[":id"].messages.$post({ ...design(id), json: body })
        ).json()) as ThreadItem,
      /** The first answer wins: a later one, or one to a withdrawn question, is 409 `question_closed`. */
      answer: async (id: string, questionId: string, body: AnswerBody) =>
        (
          await v1.designs[":id"].questions[":questionId"].answer.$post({
            param: { id, questionId },
            json: body,
          })
        ).json(),
      /** Stops the agent's turn. The runner's `stopped` notice arrives through `design.thread`. */
      stop: async (id: string): Promise<void> => {
        await v1.designs[":id"].stop.$post(design(id));
      },
      /**
       * A page of the thread, oldest first: the newest `limit` (at most 50) items before
       * `before`, a thread seq. Fewer than `limit` means there are none older.
       */
      thread: async (id: string, page: { before?: number; limit?: number } = {}) => {
        const query = {
          ...(page.before === undefined ? {} : { before: String(page.before) }),
          ...(page.limit === undefined ? {} : { limit: String(page.limit) }),
        };
        const answer = await v1.designs[":id"].thread.$get({ ...design(id), query });
        return { items: (await answer.json()).items as ThreadItem[] };
      },
      /** A person's image, straight to storage: an asset for the canvas, or a message's attachment. */
      upload: async (id: string, file: UploadFile) => {
        const crypto = opts.crypto ?? (globalThis.crypto as unknown as Randomness);
        const sha256 = hex(await crypto.subtle.digest("SHA-256", file.bytes));
        const size = file.bytes.byteLength;
        const tickets = await (
          await v1.designs[":id"].uploads.$post({
            ...design(id),
            json: { files: [{ name: file.name, contentType: file.type, size, sha256 }] },
          })
        ).json();
        const { id: uploadId, put } = tickets.files[0]!;
        await putBytes(opts.fetch ?? globalThis.fetch, put, file.bytes);
        const done = await (
          await v1.designs[":id"].uploads.complete.$post({
            ...design(id),
            json: { ids: [uploadId] },
          })
        ).json();
        return done.files[0]!;
      },

      /**
       * The design's pull request as GitHub has it (docs/cloud.md, "Pull requests"). Every
       * answer is the whole tab, `nextAction` included, and the design's head row follows it.
       */
      pullRequest: {
        get: async (id: string) => (await pullRequest.$get(design(id))).json(),
        /** One changed file and its diff, for a card opened in the tab. */
        file: async (id: string, path: string) =>
          (await pullRequest.files.$get({ ...design(id), query: { path } })).json(),
        /** A draft, as the person. 409 `no_changes`, `branch_not_pushed` or `no_repository`. */
        open: async (id: string) => (await pullRequest.$post(design(id))).json(),
        ready: async (id: string) => (await pullRequest.ready.$post(design(id))).json(),
        /**
         * Merges the commit the person looked at. `bypass` only once they chose to merge past
         * what the repo's rules still want: GitHub then decides whether they may.
         */
        merge: async (id: string, body: { headSha: string; bypass?: boolean }) =>
          (await pullRequest.merge.$post({ ...design(id), json: body })).json(),
        autoMerge: async (id: string, on: boolean) => {
          const route = pullRequest["auto-merge"];
          return (await (on ? route.$post(design(id)) : route.$delete(design(id)))).json();
        },
        close: async (id: string) => (await pullRequest.close.$post(design(id))).json(),
        updateBranch: async (id: string, body: { headSha: string }) =>
          (await pullRequest["update-branch"].$post({ ...design(id), json: body })).json(),
      },
    },

    /** Seals named live queries. The live module calls this; apps use `live.subscribe`. */
    live: async (queries: { name: string; args?: unknown }[]) =>
      (await v1.live.$post({ json: { queries } })).json(),
  };
}

export type Api = ReturnType<typeof createApi>;

type Designs = Api["designs"];
/** What a person says to the agent: their words, and the images they attach, by `ref`. */
export interface SendMessageBody {
  text: string;
  attachments?: string[];
}
/**
 * An answer to a question row: for a `question`, each question's text to the label chosen or
 * the person's own words; for a `plan` or a `permission`, yes or no, with a note.
 */
export interface AnswerBody {
  answers?: Record<string, string>;
  approved?: boolean;
  note?: string;
}
export type ThreadPage = Awaited<ReturnType<Designs["thread"]>>;
/** What the pull request tab shows (`GET /v1/designs/:id/pull-request`). */
export type PullRequestTab = Awaited<ReturnType<Designs["pullRequest"]["get"]>>;
/** One changed file and its diff. */
export type PullRequestFile = Awaited<ReturnType<Designs["pullRequest"]["file"]>>;

async function putBytes(
  fetch: Fetch,
  put: { url: string; headers: Record<string, string> },
  bytes: Uint8Array,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(put.url, {
      method: "PUT",
      headers: put.headers,
      body: bytes as Uint8Array<ArrayBuffer>,
    });
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) {
    throw new ApiError(response.status, "upstream_unavailable", "The file could not be uploaded.");
  }
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
