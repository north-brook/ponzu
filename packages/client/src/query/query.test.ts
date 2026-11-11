import { expect, test } from "bun:test";
import { ApiError } from "../errors.ts";
import { createFakeBackend } from "../testing/backend.ts";
import { settle } from "../testing/clock.ts";
import { createQueryClient } from "./client.ts";
import { queryKeys } from "./keys.ts";
import { invalidateFromLive } from "./live.ts";
import { ponzuMutations } from "./mutations.ts";
import { ponzuQueries } from "./queries.ts";

/** Maya on a device, with the client's queries and mutations over the in-memory backend. */
function device() {
  const backend = createFakeBackend();
  const maya = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const own = backend.addWorkspace({
    login: "maya",
    kind: "personal",
    members: { [maya.id]: "admin" },
    installed: false,
  });
  const client = backend.connect(maya);
  const queryClient = createQueryClient();
  return {
    backend,
    maya,
    own,
    client,
    queryClient,
    queries: ponzuQueries(client.api),
    mutate: <V, R>(options: { mutationFn?: (vars: V) => Promise<R> }, vars: V) =>
      queryClient.getMutationCache().build(queryClient, options).execute(vars),
    mutations: ponzuMutations(client.api, queryClient),
  };
}

test("a query that was refused is not asked again; one that got no answer is", () => {
  const retry = createQueryClient().getDefaultOptions().queries!.retry as (
    failures: number,
    error: unknown,
  ) => boolean;
  expect(retry(0, new ApiError(404, "not_found", "No."))).toBe(false);
  expect(retry(0, new ApiError(0, "network", "Offline."))).toBe(true);
  expect(retry(0, new ApiError(503, "database_unavailable", "Later."))).toBe(true);
  expect(retry(2, new ApiError(0, "network", "Offline."))).toBe(false);
});

test("a sync after GitHub's install page puts the account's new state in the cache, and asks for me again", async () => {
  const { queryClient, queries, mutations, mutate, own } = device();
  const before = await queryClient.fetchQuery(queries.githubAccounts());
  expect(before.accounts.map((a) => a.status)).toEqual(["not_installed"]);
  await queryClient.fetchQuery(queries.me());

  await mutate(mutations.installLink(), { client: "mac", githubAccountId: own.githubAccountId });
  await mutate(mutations.syncGithub(), undefined);

  const after = queryClient.getQueryData(queryKeys.githubAccounts());
  expect(after?.accounts.map((a) => [a.status, a.workspaceId])).toEqual([["ready", own.id]]);
  expect(queryClient.getQueryState(queryKeys.me())?.isInvalidated).toBe(true);
});

test("a recorded step and a connected Claude show in `me` at once", async () => {
  const { queryClient, queries, mutations, mutate } = device();
  await queryClient.fetchQuery(queries.me());

  await mutate(mutations.recordOnboarding(), "where");
  expect(queryClient.getQueryData(queryKeys.me())?.onboarding.whereConfirmedAt).not.toBeNull();

  await mutate(mutations.connectApiKey(), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  expect(queryClient.getQueryData(queryKeys.me())?.claudeAccount?.kind).toBe("api_key");
  expect(queryClient.getQueryData(queryKeys.claudeAccount())?.label).toContain("…wxyz");

  await mutate(mutations.disconnectClaude(), undefined);
  expect(queryClient.getQueryData(queryKeys.me())?.claudeAccount).toBeNull();
});

test("a change to the person's row on another device asks for what it covers again", async () => {
  const { backend, maya, queryClient, queries, client } = device();
  await queryClient.fetchQuery(queries.me());
  await queryClient.fetchQuery(queries.claudeAccount());
  const stop = invalidateFromLive(queryClient, client.live);
  await settle();
  // The first rows are what was read: nothing is out of date yet.
  expect(queryClient.getQueryState(queryKeys.me())?.isInvalidated).toBe(false);

  backend.claude.connect(maya.id);
  backend.finishStep(maya.id, "where");
  await settle();

  expect(queryClient.getQueryState(queryKeys.me())?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(queryKeys.claudeAccount())?.isInvalidated).toBe(true);
  stop();
  client.live.close();
});

test("a role change asks for the workspace again, whether or not it was refused", async () => {
  const { backend, maya, queryClient, queries, mutations, mutate } = device();
  const team = backend.addWorkspace({ login: "north-brook", members: { [maya.id]: "admin" } });
  await queryClient.fetchQuery(queries.workspace(team.id));

  const refused = mutate(mutations.setRole(), {
    workspaceId: team.id,
    userId: maya.id,
    role: "member",
  });
  await expect(refused).rejects.toMatchObject({ code: "last_admin" });
  expect(queryClient.getQueryState(queryKeys.workspace(team.id))?.isInvalidated).toBe(true);
});
