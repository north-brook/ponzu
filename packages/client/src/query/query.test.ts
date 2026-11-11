import { expect, test } from "bun:test";
import { MutationObserver, type MutationOptions } from "@tanstack/react-query";
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
    /** Runs a mutation as `useMutation` would. */
    mutate: <R, V, C>(options: MutationOptions<R, Error, V, C>, vars: V) =>
      new MutationObserver(queryClient, options).mutate(vars),
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

  const after = queryClient.getQueryData(queries.githubAccounts().queryKey);
  expect(after?.accounts.map((a) => [a.status, a.workspaceId])).toEqual([["ready", own.id]]);
  expect(queryClient.getQueryState(queryKeys.me())?.isInvalidated).toBe(true);
});

test("a recorded step and a connected Claude show in `me` at once", async () => {
  const { queryClient, queries, mutations, mutate } = device();
  await queryClient.fetchQuery(queries.me());

  await mutate(mutations.recordOnboarding(), "where");
  expect(
    queryClient.getQueryData(queries.me().queryKey)?.onboarding.whereConfirmedAt,
  ).not.toBeNull();

  await mutate(mutations.connectApiKey(), "sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  expect(queryClient.getQueryData(queries.me().queryKey)?.claudeAccount?.kind).toBe("api_key");
  expect(queryClient.getQueryData(queries.claudeAccount().queryKey)?.label).toContain("…wxyz");

  await mutate(mutations.disconnectClaude(), undefined);
  expect(queryClient.getQueryData(queries.me().queryKey)?.claudeAccount).toBeNull();
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

test("the same row delivered again asks for nothing, and a step asks only for `me`", async () => {
  const { backend, maya, queryClient, queries, client } = device();
  const read = () =>
    Promise.all([
      queryClient.fetchQuery({ ...queries.me(), staleTime: 0 }),
      queryClient.fetchQuery({ ...queries.claudeAccount(), staleTime: 0 }),
      queryClient.fetchQuery({ ...queries.claudeDefaults(), staleTime: 0 }),
    ]);
  await read();
  const stop = invalidateFromLive(queryClient, client.live);
  await settle();
  const invalidated = () =>
    [queryKeys.me(), queryKeys.claudeAccount(), queryKeys.claudeDefaults()].map(
      (key) => queryClient.getQueryState(key)?.isInvalidated,
    );

  // Out of sight and back: the live query comes back whole, with the rows as they were.
  client.live.pause();
  client.live.resume();
  await settle();
  expect(invalidated()).toEqual([false, false, false]);

  backend.finishStep(maya.id, "where");
  await settle();
  expect(invalidated()).toEqual([true, false, false]);
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

test("a ping toggle shows at once, and is put back when the API turns it down", async () => {
  const { backend, queryClient, queries, mutations, mutate } = device();
  const needsYou = () => queryClient.getQueryData(queries.notifications().queryKey)?.prefs.needsYou;
  await queryClient.fetchQuery(queries.notifications());
  // Every value the toggle shows, in turn, with no clock to wait on.
  const shown: (boolean | undefined)[] = [needsYou()];
  queryClient.getQueryCache().subscribe(() => {
    if (shown.at(-1) !== needsYou()) shown.push(needsYou());
  });

  await mutate(mutations.setPings(), { needsYou: false });
  expect(needsYou()).toBe(false);

  backend.online = false;
  await expect(mutate(mutations.setPings(), { needsYou: true })).rejects.toMatchObject({
    code: "network",
  });
  // On as soon as it was flipped, before any answer, and off again when none came.
  expect(shown).toEqual([true, false, true, false]);
});

test("a secret saved or a rebuild asked for shows in the workspace's environments at once", async () => {
  const { backend, maya, queryClient, queries, mutations, mutate } = device();
  const team = backend.addWorkspace({
    login: "north-brook",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }],
  });
  const repoId = team.repos[0]!.id;
  backend.settings.setBase(repoId, { status: "ready", builtAt: new Date().toISOString() });
  await queryClient.fetchQuery(queries.environments(team.id));
  const listed = () => queryClient.getQueryData(queries.environments(team.id).queryKey)!.repos[0]!;

  await mutate(mutations.saveSecret(), {
    workspaceId: team.id,
    repoId,
    name: "STRIPE_KEY",
    value: "sk_test_1",
    replacing: false,
  });
  expect(listed().secrets.map((s) => s.name)).toEqual(["STRIPE_KEY"]);
  await mutate(mutations.rebuildEnvironment(), { workspaceId: team.id, repoId });
  expect(listed().base.rebuild.requestedAt).not.toBeNull();
});

test("a pull request action's answer is the tab the query holds", async () => {
  const { backend, maya, queryClient, queries, mutations, mutate, client } = device();
  const team = backend.addWorkspace({
    login: "north-brook",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }],
  });
  const design = await client.api.designs.create({
    workspaceId: team.id,
    repoId: team.repos[0]!.id,
    name: "Pricing",
  });
  backend.agent(design.id).push();
  await queryClient.fetchQuery(queries.pullRequest(design.id));
  await mutate(mutations.pullRequestAction(), { designId: design.id, action: { kind: "open" } });
  const tab = queryClient.getQueryData(queries.pullRequest(design.id).queryKey);
  expect(tab?.pullRequest?.state).toBe("draft");
  expect(tab?.nextAction).toBe("ready");
});
