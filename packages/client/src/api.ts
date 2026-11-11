import type { ClientOp, PageIcon } from "@ponzu/core";
import type { ThreadItem } from "@ponzu/runner/protocol";
import type { InferRequestType } from "hono/client";
import { ApiError, networkError } from "./errors.ts";
import type { Randomness } from "./pkce.ts";
import { createRpc, type Fetch, type Rpc } from "./rpc.ts";
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
  /**
   * The scheme of the links this app takes, when it isn't `ponzu`: Ponzu Dev's `ponzu-dev`.
   * Pages the API sends a person to (GitHub's
   * setup) link back to it, so they return to the app they came from.
   */
  linkScheme?: LinkScheme;
}

/** The schemes the API will link back to (apps/api/src/github/link-scheme.ts). */
export type LinkScheme = "ponzu" | "ponzu-dev";

/** What `api.designs.create` takes. */
export type CreateDesignBody = InferRequestType<Rpc["v1"]["designs"]["$post"]>["json"];
/** What `api.claude.setDefaults` takes: the model, the effort, or both. */
export type AgentDefaultsBody = InferRequestType<Rpc["v1"]["claude"]["defaults"]["$patch"]>["json"];
/** A guided setup step that leaves no other trace (`api.onboarding`). */
export type OnboardingStep = InferRequestType<
  Rpc["v1"]["me"]["onboarding"]["$post"]
>["json"]["step"];

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

    /**
     * Records a guided setup step as done (Continue on "Where do you design?", Start designing
     * on the iPhone step). The first time counts. Answers where setup stands.
     */
    onboarding: async (step: OnboardingStep) =>
      (await v1.me.onboarding.$post({ json: { step } })).json(),

    /** The person's own Claude, which their designs run on (docs/cloud.md, "Credentials"). */
    claude: {
      /** What is connected, or `{ account: null }`. Never the credential. */
      get: async () => (await v1.claude.$get()).json(),
      /** 400 `claude_key_invalid` when Anthropic doesn't take the key. */
      connectApiKey: async (key: string) =>
        (await v1.claude["api-key"].$post({ json: { key } })).json(),
      /** A claude.ai sign-in: open `authorizeUrl`, then send the code it shows before `expiresAt`. */
      startSignIn: async () => (await v1.claude["sign-ins"].$post()).json(),
      /**
       * 400 `claude_code_invalid` (not whole, or turned away), 409 `claude_sign_in_used` and
       * 410 `claude_sign_in_expired`. Past a code that was turned away, only a new sign-in works.
       */
      sendCode: async (signInId: string, code: string) =>
        (
          await v1.claude["sign-ins"][":id"].code.$post({
            param: { id: signInId },
            json: { code },
          })
        ).json(),
      /** The person chose another way: the sign-in is given up. */
      abandonSignIn: async (signInId: string): Promise<void> => {
        await v1.claude["sign-ins"][":id"].$delete({ param: { id: signInId } });
      },
      /** Designs wait until Claude is connected again; what runs on it now stops. */
      disconnect: async (): Promise<void> => {
        await v1.claude.$delete();
      },
      /** The model and effort new designs start on, and what there is to choose from. */
      defaults: async () => (await v1.claude.defaults.$get()).json(),
      setDefaults: async (body: AgentDefaultsBody) =>
        (await v1.claude.defaults.$patch({ json: body })).json(),
    },

    github: {
      /** What "Where do you design?" lists, as of the last sync. */
      accounts: async () => (await v1.github.accounts.$get()).json(),
      /** Sync with GitHub now: on coming back to focus, and after the install page. */
      sync: async () => (await v1.github.sync.$post()).json(),
      /** GitHub's install page, with a state good for one return, to this app's links. */
      installLink: async (body: { client: "mac" | "ios"; githubAccountId?: number }) =>
        (
          await v1.github["install-link"].$post({
            json: opts.linkScheme ? { ...body, scheme: opts.linkScheme } : body,
          })
        ).json(),
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
      /**
       * In a repo the person can push to, or Scratch (`repoId` left out). With a first message
       * the agent sets off at once; a `createKey` sent again answers the design it made.
       */
      create: async (body: CreateDesignBody) => (await v1.designs.$post({ json: body })).json(),
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
      /**
       * One of the agent's questions as it stands: once answered, the answer that won and who
       * gave it. `design.questions` holds the open ones alone; this says how one closed.
       */
      question: async (id: string, questionId: string) =>
        (
          await v1.designs[":id"].questions[":questionId"].$get({ param: { id, questionId } })
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
       * Puts the picture of where the person left a comment in storage, its light and its dark
       * WebP, before or after the comment's op is committed. Answers the uploads, for
       * `attachCommentPicture` once the comment is in the thread.
       */
      uploadCommentPicture: async (
        id: string,
        messageId: string,
        files: { light: Uint8Array; dark: Uint8Array },
      ): Promise<string[]> => {
        const crypto = opts.crypto ?? (globalThis.crypto as unknown as Randomness);
        const themes = [
          { name: "light.webp", bytes: files.light },
          { name: "dark.webp", bytes: files.dark },
        ];
        const declared = await Promise.all(
          themes.map(async ({ name, bytes }) => ({
            name,
            contentType: "image/webp",
            size: bytes.byteLength,
            sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
          })),
        );
        const route = v1.designs[":id"].comments[":messageId"].picture;
        const tickets = await (
          await route.$post({ param: { id, messageId }, json: { files: declared } })
        ).json();
        await Promise.all(
          tickets.files.map((ticket, i) =>
            putBytes(opts.fetch ?? globalThis.fetch, ticket.put, themes[i]!.bytes),
          ),
        );
        return tickets.files.map((ticket) => ticket.id);
      },
      /**
       * Gives the person's comment the picture uploaded for it: answers the picture it keeps,
       * which is the first it was given. 404 `not_found` until the comment's op is committed.
       */
      attachCommentPicture: async (id: string, messageId: string, uploads: string[]) =>
        (
          await v1.designs[":id"].comments[":messageId"].picture.complete.$post({
            param: { id, messageId },
            json: { ids: uploads },
          })
        ).json(),

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

    /*
     * Settings: notifications and devices, environments, usage and the cap, the account
     * (docs/cloud.md, "Notifications", "Environments", "Billing", "Deleting an account").
     */

    notifications: {
      /** The person's ping toggles and their devices. */
      get: async () => (await v1.me.notifications.$get()).json(),
      /** Change some toggles; the rest stay. */
      set: async (prefs: {
        needsYou?: boolean;
        replies?: boolean;
        prReady?: boolean;
        teammateComments?: boolean;
        emailDigest?: boolean;
      }) => (await v1.me.notifications.$patch({ json: prefs })).json(),
    },

    devices: {
      /**
       * This device, for pings: once the person turns notifications on, and at each launch.
       * 409 `push_token_taken` while another account holds the token from another install.
       */
      register: async (body: {
        platform: "ios" | "macos";
        /** The APNs device token, in hex. */
        pushToken: string;
        pushEnvironment: "development" | "production";
        /** The app's random id for this install, made once and kept in the Keychain. */
        installId: string;
        name?: string | null;
        appVersion?: string | null;
        /** iOS has notifications for Ponzu turned off. */
        blocked?: boolean;
      }) => (await v1.me.devices.$post({ json: body })).json(),
      /** 409 `push_token_taken` for a token another of the person's devices has. */
      update: async (
        id: string,
        changes: {
          pings?: boolean;
          blocked?: boolean;
          name?: string | null;
          appVersion?: string | null;
          pushToken?: string;
        },
      ) => (await v1.me.devices[":id"].$patch({ param: { id }, json: changes })).json(),
      /** On signing out of the device. */
      remove: async (id: string): Promise<void> => {
        await v1.me.devices[":id"].$delete({ param: { id } });
      },
    },

    environments: {
      /** The workspace's repos with an environment, that the person can read. */
      list: async (workspaceId: string) =>
        (await v1.workspaces[":id"].environments.$get(design(workspaceId))).json(),
      get: async (repoId: string) =>
        (await v1.repos[":id"].environment.$get(design(repoId))).json(),
      /** Anyone who can push. Kept for the repo's next start until building a base is built. */
      rebuild: async (repoId: string) =>
        (await v1.repos[":id"].environment.rebuild.$post(design(repoId))).json(),
      /** Admins. 409 `secret_exists`, `secrets_full`; 400 `secret_name_reserved`. */
      addSecret: async (repoId: string, body: { name: string; value: string }) =>
        (await v1.repos[":id"].environment.secrets.$post({ ...design(repoId), json: body })).json(),
      /** Admins. The old value is gone for good. */
      replaceSecret: async (repoId: string, name: string, value: string) =>
        (
          await v1.repos[":id"].environment.secrets[":name"].$put({
            param: { id: repoId, name },
            json: { value },
          })
        ).json(),
      /** Admins. */
      removeSecret: async (repoId: string, name: string) =>
        (
          await v1.repos[":id"].environment.secrets[":name"].$delete({
            param: { id: repoId, name },
          })
        ).json(),
    },

    usage: {
      /** This billing period so far, as the person may see it. */
      get: async (workspaceId: string) =>
        (await v1.workspaces[":id"].usage.$get(design(workspaceId))).json(),
      /** Admins. Whole dollars; 400 `cap_too_low` below what the period has billed. */
      setCap: async (workspaceId: string, capUsd: number) =>
        (
          await v1.workspaces[":id"].billing.$patch({ ...design(workspaceId), json: { capUsd } })
        ).json(),
    },

    account: {
      /**
       * Deletes the account, confirmed with the person's GitHub login. 409 `sole_admin` while
       * they are the only admin of a team others are in. Sign out once it resolves.
       */
      delete: async (confirm: string): Promise<void> => {
        await v1.me.$delete({ json: { confirm } });
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
