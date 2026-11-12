import { emptyDoc, newId } from "@ponzu/core";
import {
  BRANCH_TAKEN,
  CREATE_KEY_TAKEN,
  createDesign,
  type Design,
  findDesignByCreateKey,
  getClaudeAccount,
  listRepoBranches,
  QueryError,
  type User,
} from "@ponzu/db";
import { appSession } from "../analytics/scope.ts";
import {
  checkOffered,
  DEFAULT_EFFORT,
  effortOrDefault,
  modelOrDefault,
  offerFor,
} from "../claude/models.ts";
import { requestWake, type WakeDeps } from "../sandboxes/wake.ts";
import { personFor } from "./actor.ts";
import { branchFor, branchTopic } from "./branch.ts";

/*
 * Making a design, as the composer does it: the design, its first page, and with a first
 * message, that message in its thread and its feed, in one statement, and then its sandbox
 * asked for. The person's own Claude is the one it runs on from start to finish (docs/cloud.md,
 * "Whose Claude"), and its branch is named for what the message is about.
 */

export interface NewDesignRequest {
  user: User;
  workspaceId: string;
  /** Null for Scratch, which has no branch. */
  repo: { id: string } | null;
  name: string;
  message?: { text: string };
  model?: string;
  effort?: string;
  createKey?: string;
}

/** How often a create tries again for a branch someone else took at the same moment. */
const BRANCH_TRIES = 3;

/**
 * Make the design. When `createKey` already made one, that one is answered instead and nothing
 * else happens (`created: false`).
 */
export async function startDesign(
  deps: WakeDeps,
  request: NewDesignRequest,
): Promise<{ design: Design; created: boolean }> {
  const { user, repo, name, message, createKey } = request;
  const claude = await getClaudeAccount(deps.db, user.id);
  // What it runs on is what the person's account offers: a choice it doesn't is refused here,
  // and a saved default it no longer does gives way to what runs in its place.
  const offer = offerFor(claude);
  const model = request.model ?? modelOrDefault(offer, user.defaultModel);
  checkOffered(offer, model, request.effort);
  const effort =
    request.effort ?? effortOrDefault(offer, model, user.defaultEffort ?? DEFAULT_EFFORT);
  const topic = branchTopic(message?.text ?? (name === "Untitled" ? "" : name));
  const firstMessage = message && {
    item: { text: message.text, from: personFor(user) },
    event: { text: message.text },
    posthogSessionId: appSession(),
  };
  for (let attempt = 1; ; attempt++) {
    const taken = repo
      ? await listRepoBranches(deps.db, { repoId: repo.id, prefix: `pz/${topic}` })
      : [];
    try {
      const design = await createDesign(deps.db, {
        workspaceId: request.workspaceId,
        repoId: repo?.id ?? null,
        ownerId: user.id,
        claudeAccountId: claude && claude.status !== "revoked" ? claude.id : null,
        name,
        branch: repo ? branchFor(topic, taken) : null,
        model,
        effort,
        createKey: createKey ?? null,
        doc: { ...emptyDoc(name), pages: [{ id: newId("pg"), name: "Page 1", artboards: [] }] },
        ...(firstMessage ? { firstMessage } : {}),
      });
      if (message) await requestWake(deps, design.id, "message");
      return { design, created: true };
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      if (createKey && error.message.includes(CREATE_KEY_TAKEN)) {
        // The same create, sent twice at once: the other one made it.
        const made = await findDesignByCreateKey(deps.db, { ownerId: user.id, createKey });
        if (made) return { design: made, created: false };
      }
      if (!error.message.includes(BRANCH_TAKEN) || attempt >= BRANCH_TRIES) throw error;
    }
  }
}
