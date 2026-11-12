import type { Clock } from "@ponzu/sandbox";
import type { Fetch } from "../deps/fetch.ts";

/*
 * PostHog's private API, for the one thing the API asks of it: forgetting a person whose
 * account is deleted (docs/cloud.md, "Deleting an account"). It is a different door from the
 * one events go in by: a personal API key with `person:write` on the project, sent as a bearer
 * to the app host (`us.posthog.com`), not the project token sent to the ingestion host.
 *
 * Plain fetch, not posthog-node: the server SDK captures and reads flags and has no call for
 * deleting people. The key goes out as the bearer and nowhere else, and no answer's body is
 * ever logged or put in an error.
 */

export interface PosthogAdminConfig {
  /** A personal API key with `person:write` scoped to the project: a secret. */
  personalApiKey: string;
  /** The project's numeric id. */
  projectId: string;
  /** PostHog's app host, without a trailing slash: `https://us.posthog.com`. */
  host: string;
}

export interface PosthogAdmin {
  /**
   * Asks PostHog to delete the person behind `distinctId` with their events and recordings.
   * PostHog takes the request at once and deletes in batches later. A person PostHog never
   * had is done too. Throws when PostHog did not take it, so a job tries again.
   */
  forgetPerson(distinctId: string): Promise<void>;
}

/** PostHog's call has this long to answer. */
const TIMEOUT_MS = 10_000;

/** The exact body `forgetPerson` posts, exported for the test that holds it to it. */
export function bulkDeleteBody(distinctId: string) {
  return { distinct_ids: [distinctId], delete_events: true, delete_recordings: true };
}

export function createPosthogAdmin({
  config,
  fetch,
  clock,
}: {
  config: PosthogAdminConfig;
  fetch: Fetch;
  clock: Clock;
}): PosthogAdmin {
  const url = `${config.host}/api/projects/${encodeURIComponent(config.projectId)}/persons/bulk_delete/`;
  return {
    async forgetPerson(distinctId) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.personalApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(bulkDeleteBody(distinctId)),
          signal: clock.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        throw new PosthogAdminError("POST persons/bulk_delete did not answer", { cause });
      }
      const body = await readJson(response);
      if (!response.ok) {
        throw new PosthogAdminError(`POST persons/bulk_delete answered ${response.status}`, {
          status: response.status,
        });
      }
      // PostHog answers 202 and, in versions that say, the ids it could not queue.
      const errors = body.deletion_errors;
      if (Array.isArray(errors) && errors.length > 0) {
        throw new PosthogAdminError(
          `POST persons/bulk_delete answered ${response.status} with ${errors.length} deletion errors`,
          { status: response.status },
        );
      }
    },
  };
}

/**
 * PostHog did not take a request, with its status when it answered. Its own class, not the
 * API's `UpstreamError`: it is thrown only in a job, never into a person's request.
 */
export class PosthogAdminError extends Error {
  readonly status?: number;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PosthogAdminError";
    if (options.status !== undefined) this.status = options.status;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
