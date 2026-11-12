import type { PosthogAdminConfig } from "../analytics/posthog-admin.ts";
import type { Fetch } from "../deps/fetch.ts";

/*
 * PostHog's private API, in memory, at the HTTP boundary: the API's real `createPosthogAdmin`
 * talks to `fetch` here. It answers `persons/bulk_delete` as PostHog's `posthog/api/person.py`
 * does (202, with how many people it found and the ids it could not queue), takes only its own
 * personal key as the bearer, and records every request as it arrived.
 */

export class FakePosthogAdmin {
  /** What `createPosthogAdmin` is given in a test. */
  readonly config: PosthogAdminConfig = {
    personalApiKey: "phx_fake_personal_api_key_0000000000",
    projectId: "4242",
    host: "https://posthog.test",
  };

  /** Every request, as it arrived: its method, URL, authorization header and parsed body. */
  readonly requests: { method: string; url: string; authorization: string; body: unknown }[] = [];
  /** The distinct ids PostHog has people for. A request for others finds nobody, and is done. */
  readonly people = new Set<string>();
  /** The distinct ids PostHog was asked to delete and took, in order. */
  readonly forgotten: string[] = [];
  readonly #answers: { status: number; body: unknown }[] = [];

  /** Makes the next requests answer these, one each, as PostHog failing would. */
  answerNext(...answers: { status: number; body?: unknown }[]): void {
    this.#answers.push(
      ...answers.map(({ status, body = { detail: "Server Error" } }) => ({ status, body })),
    );
  }

  readonly fetch: Fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const authorization = new Headers(init.headers).get("authorization") ?? "";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    this.requests.push({ method, url, authorization, body });
    const scripted = this.#answers.shift();
    if (scripted) return Response.json(scripted.body, { status: scripted.status });

    const { host, projectId, personalApiKey } = this.config;
    if (method !== "POST" || url !== `${host}/api/projects/${projectId}/persons/bulk_delete/`) {
      return Response.json({ detail: "Not found." }, { status: 404 });
    }
    if (authorization !== `Bearer ${personalApiKey}`) {
      return Response.json({ detail: "Invalid personal API key." }, { status: 401 });
    }
    const ids: unknown = body?.distinct_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000) {
      return Response.json({ detail: "Pass between 1 and 1000 distinct_ids." }, { status: 400 });
    }
    let found = 0;
    for (const id of ids) {
      if (this.people.delete(String(id))) found++;
      this.forgotten.push(String(id));
    }
    return Response.json({ persons_found: found, deletion_errors: [] }, { status: 202 });
  };
}
