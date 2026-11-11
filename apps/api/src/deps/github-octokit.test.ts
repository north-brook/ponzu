import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getWorkspaceByInstallation, listUserWorkspaces, listWorkspaceRepos } from "@ponzu/db";
import { reconcileInstallation } from "../github/installations.ts";
import { syncGithub } from "../github/sync.ts";
import { githubUserToken } from "../github/user-token.ts";
import { UpstreamError } from "../http/errors.ts";
import { createTestApp, type SignedInPerson, type TestApp } from "../testing/index.ts";
import { createGithub, type Github } from "./github.ts";

// What Octokit brings that the hand-written client did not have: auth-app's token cache (timed
// here by the API's clock) and its shared mints, the paginator following GitHub's `Link`, and
// `@octokit/graphql`'s error shape.

const HOUR = 3600_000;
const MINUTE = 60_000;

let t: TestApp;
let maya: SignedInPerson;
beforeAll(async () => {
  t = await createTestApp();
  maya = await t.signInAs({ login: "maya" });
  t.github.installations.push({
    id: 9002,
    account: { id: 77, login: "north-brook", type: "Organization" },
    repositorySelection: "selected",
    repositories: [
      { id: 1, fullName: "north-brook/fernwood", access: { [maya.github.id]: "write" } },
      { id: 2, fullName: "north-brook/site", access: { [maya.github.id]: "read" } },
    ],
  });
});
afterAll(() => t.close());

/** A client of its own, as a function instance has: nothing kept from any other. */
function freshGithub(fetch = t.github.fetch): Github {
  return createGithub({ ...t.github.credentials, fetch, clock: t.clock });
}

const minted = () => t.github.installationTokenRequests.length;

describe("installation tokens", () => {
  const fernwood = { id: 1, fullName: "north-brook/fernwood" };

  test("one kept for the App's own questions is reused until five minutes before its hour, by the API's clock", async () => {
    const github = freshGithub();
    const ask = () =>
      github.getRepoPermission({
        installationId: 9002,
        repository: fernwood,
        user: { id: maya.github.id, login: "maya" },
      });
    const before = minted();

    expect(await ask()).toBe("write");
    expect(minted()).toBe(before + 1);
    t.clock.advance(54 * MINUTE);
    expect(await ask()).toBe("write");
    expect(minted()).toBe(before + 1);

    t.clock.advance(MINUTE);
    expect(await ask()).toBe("write");
    expect(minted()).toBe(before + 2);
  });

  test("a token for another repository or other permissions is another token", async () => {
    const github = freshGithub();
    const before = minted();
    const ask = (repository: { id: number; fullName: string }) =>
      github.getRepoPermission({
        installationId: 9002,
        repository,
        user: { id: maya.github.id, login: "maya" },
      });

    await ask(fernwood);
    await ask({ id: 2, fullName: "north-brook/site" });
    await ask(fernwood);

    expect(t.github.installationTokenRequests.slice(before).map(({ body }) => body)).toEqual([
      { repository_ids: [1], permissions: { metadata: "read" } },
      { repository_ids: [2], permissions: { metadata: "read" } },
    ]);
  });

  test("one asked for directly is minted every time, and asks for the same token at once share a mint", async () => {
    const github = freshGithub();
    const scope = {
      installationId: 9002,
      repositoryIds: [1],
      permissions: { contents: "read" as const },
    };
    const before = minted();

    const [first, second] = await Promise.all([
      github.createInstallationToken(scope),
      github.createInstallationToken(scope),
    ]);
    expect(first).toEqual(second);
    expect(minted()).toBe(before + 1);

    const third = await github.createInstallationToken(scope);
    expect(third.token).not.toBe(first.token);
    expect(third.expiresAt.getTime()).toBe(t.clock.now() + HOUR);
    expect(minted()).toBe(before + 2);
  });
});

describe("lists", () => {
  test("are read by GitHub's Link to the next page", async () => {
    const asked: string[] = [];
    const github = freshGithub((url, init) => {
      asked.push(new URL(url).search);
      return t.github.fetch(url, init);
    });
    t.github.installations.push({
      id: 9300,
      account: { id: 93, login: "paged", type: "Organization" },
      repositorySelection: "all",
      repositories: Array.from({ length: 150 }, (_, index) => ({
        id: 9_300_000 + index,
        fullName: `paged/r${index}`,
        access: { [maya.github.id]: "read" as const },
      })),
    });
    const token = await githubUserToken(t.deps, maya.userId);

    const listed = await github.listInstallationRepositories(token, 9300);

    expect(listed).toMatchObject({ complete: true });
    expect(listed.items).toHaveLength(150);
    expect(asked.slice(-2)).toEqual(["?per_page=100", "?per_page=100&page=2"]);
  });

  test("a 409 is GitHub failing, not an empty list", async () => {
    // Octokit's paginator takes a 409 for an empty list (an empty repository's commits).
    const token = await githubUserToken(t.deps, maya.userId);
    t.github.failNext("/user/installations", 409);

    const error = await t.deps.github.listInstallations(token).catch((caught) => caught);

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.status).toBe(409);
  });
});

describe("GraphQL", () => {
  const repo = { installationId: 9002, repository: { id: 1, fullName: "north-brook/fernwood" } };
  const query = { branch: "pz/topic", defaultBranch: "main", number: 7 };

  /** A client whose GraphQL calls GitHub answers with `body`, at `status`. */
  function answering(body: unknown, status = 200) {
    return freshGithub((url, init) =>
      new URL(url).pathname === "/graphql"
        ? Promise.resolve(Response.json(body, { status }))
        : t.github.fetch(url, init),
    );
  }
  const repository = {
    squashMergeAllowed: true,
    mergeCommitAllowed: false,
    rebaseMergeAllowed: false,
    autoMergeAllowed: false,
    ref: null,
  };

  test("a 200 with errors about the pull request alone is a read without it", async () => {
    const github = answering({
      data: { repository: { ...repository, pullRequest: null } },
      errors: [{ type: "NOT_FOUND", path: ["repository", "pullRequest"], message: "Not found" }],
    });

    expect(await github.readPullRequest(repo, query)).toEqual({
      mergeMethods: ["squash"],
      autoMergeAllowed: false,
      branch: null,
      newest: null,
      pullRequest: null,
    });
  });

  test("a 200 with any other errors is refused: 404 for a repository GitHub has not, else 502", async () => {
    const missing = await answering({
      data: { repository: null },
      errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Not found" }],
    })
      .readPullRequest(repo, query)
      .catch((caught) => caught);
    expect(missing).toBeInstanceOf(UpstreamError);
    expect(missing.status).toBe(404);

    const limited = await answering({
      data: null,
      errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    })
      .readPullRequest(repo, query)
      .catch((caught) => caught);
    expect(limited).toBeInstanceOf(UpstreamError);
    expect(limited.status).toBe(502);
  });

  test("an answer that is not a 200 is GitHub's status", async () => {
    const error = await answering({ message: "Server Error" }, 503)
      .readPullRequest(repo, query)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.status).toBe(503);
  });

  test("a person's mutation GitHub refuses is forbidden or refused, by the error's type", async () => {
    const token = await githubUserToken(t.deps, maya.userId);
    const refusing = (type: string) =>
      answering({ data: null, errors: [{ type, message: "No" }] }).markReady(token, "PR_1");

    expect(await refusing("FORBIDDEN")).toBe("forbidden");
    expect(await refusing("UNPROCESSABLE")).toBe("refused");
  });
});

describe("an answer that does not arrive whole", () => {
  // Octokit reads a body it fails to read, or one that is not JSON, as an empty success, and its
  // paginator then as an empty, complete list: a sync would drop everything it no longer saw.

  type Cut = "dropped" | "timed out" | "html";

  /** A client whose answers to `path` start well and then are cut off as `how` says. */
  function cuttingOff(path: string, how: Cut) {
    return freshGithub(async (url, init) => {
      if (new URL(url).pathname !== path) return t.github.fetch(url, init);
      if (how === "html") {
        return new Response("<html>Bad gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"total_count":1,"install'));
          if (how === "dropped") controller.error(new TypeError("terminated"));
          else signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      });
      if (how === "timed out") queueMicrotask(() => t.clock.advance(11_000));
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
  }

  const cuts: Cut[] = ["dropped", "timed out", "html"];

  test.each(cuts)("a list %s is GitHub failing, not an empty list", async (how) => {
    const token = await githubUserToken(t.deps, maya.userId);
    const installations = await cuttingOff("/user/installations", how)
      .listInstallations(token)
      .catch((caught) => caught);
    expect(installations).toBeInstanceOf(UpstreamError);

    const { token: installationToken } = await t.deps.github.createInstallationToken({
      installationId: 9002,
    });
    const repositories = await cuttingOff("/installation/repositories", how)
      .listRepositoriesAsInstallation(installationToken)
      .catch((caught) => caught);
    expect(repositories).toBeInstanceOf(UpstreamError);
  });

  test.each(cuts)("one read %s is GitHub failing, not a blank", async (how) => {
    const token = await githubUserToken(t.deps, maya.userId);
    const error = await cuttingOff("/user", how)
      .getUser(token)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.message).toBe(
      how === "html" ? "GET /user answered 200 with no JSON" : "GET /user did not answer",
    );
  });

  test("a sync cut off keeps the person's workspaces and the workspace's repos", async () => {
    await syncGithub(t.deps, maya.userId);
    const workspace = (await getWorkspaceByInstallation(t.db, 9002))!;
    const workspacesBefore = await listUserWorkspaces(t.db, maya.userId);
    const reposBefore = await listWorkspaceRepos(t.db, {
      workspaceId: workspace.id,
      userId: maya.userId,
    });
    expect(workspacesBefore.map(({ githubLogin }) => githubLogin)).toContain("north-brook");
    expect(reposBefore.length).toBeGreaterThan(0);

    await expect(
      syncGithub({ ...t.deps, github: cuttingOff("/user/installations", "dropped") }, maya.userId),
    ).rejects.toBeInstanceOf(UpstreamError);
    await expect(
      reconcileInstallation(
        { ...t.deps, github: cuttingOff("/installation/repositories", "dropped") },
        9002,
      ),
    ).rejects.toBeInstanceOf(UpstreamError);

    expect(await listUserWorkspaces(t.db, maya.userId)).toEqual(workspacesBefore);
    expect(
      await listWorkspaceRepos(t.db, { workspaceId: workspace.id, userId: maya.userId }),
    ).toEqual(reposBefore);
  });
});

test("the App's JWT is dated a minute back and runs nine minutes on, by the API's clock", async () => {
  let jwt = "";
  const github = freshGithub((url, init) => {
    if (new URL(url).pathname.startsWith("/app/")) {
      jwt = new Headers(init?.headers).get("authorization")!.replace("Bearer ", "");
    }
    return t.github.fetch(url, init);
  });

  await github.getInstallation(9002);

  const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
  const now = Math.floor(t.clock.now() / 1000);
  expect(claims).toMatchObject({ iat: now - 60, exp: now + 540 });
});

test("the App's JWT is signed at the API's clock, wherever it is", async () => {
  // Past any time a JWT signed at the machine's clock would still be good at; the fake checks
  // the JWT's expiry against its own clock, which is the API's.
  t.clock.advance(2 * 365 * 24 * HOUR);
  expect(await freshGithub().getInstallation(9002)).toMatchObject({ id: 9002 });
});
