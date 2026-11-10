import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { emptyDoc } from "@ponzu/core";
import {
  createDesign,
  events,
  getDesign,
  getGithubUserToken,
  getWorkspaceByInstallation,
  listUserWorkspaces,
  repos,
  workspaces,
} from "@ponzu/db";
import { syncGithub } from "../github/sync.ts";
import {
  createTestApp,
  type FakeInstallation,
  type SignedInPerson,
  type TestApp,
} from "../testing/index.ts";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

let nextId = 110_000;
const id = () => nextId++;

/** Post a delivery as GitHub would, and wait for the work it started. */
async function deliver(
  event: string,
  payload: unknown,
  options: { id?: string; secret?: string } = {},
) {
  const response = await t.app.request(
    "/v1/github/webhook",
    t.github.delivery(event, payload, options),
  );
  await t.backgroundDone();
  return response;
}

function installOnOrg(login: string, people: SignedInPerson[]): FakeInstallation {
  const installation: FakeInstallation = {
    id: id(),
    account: { id: id(), login, type: "Organization" },
    repositorySelection: "selected",
    repositories: [
      {
        id: id(),
        fullName: `${login}/app`,
        access: Object.fromEntries(people.map((person) => [person.github.id, "write" as const])),
      },
    ],
  };
  t.github.installations.push(installation);
  return installation;
}

const reposOf = async (workspaceId: string) =>
  Object.fromEntries(
    (await t.db.select().from(repos))
      .filter((repo) => repo.workspaceId === workspaceId)
      .map((repo) => [repo.fullName, repo.removedAt === null]),
  );

const eventsOf = async (designId: string) =>
  (await t.db.select().from(events)).filter((event) => event.designId === designId);

const installationPayload = (action: string, installation: FakeInstallation, sender: number) => ({
  action,
  installation: { id: installation.id, account: installation.account },
  sender: { id: sender, login: "someone" },
});

/** A person in an organization with the App, and a design on a branch of its repo. */
async function designInRepo(login: string) {
  const person = await t.signInAs({ login: `${login}-person` });
  const installation = installOnOrg(login, [person]);
  const [workspace] = await syncGithub(t.deps, person.userId);
  const repository = installation.repositories[0]!;
  const repo = (await t.db.select().from(repos)).find((r) => r.githubRepoId === repository.id)!;
  const design = await createDesign(t.db, {
    workspaceId: workspace!.id,
    repoId: repo.id,
    ownerId: person.userId,
    claudeAccountId: null,
    name: "Checkout",
    branch: "pz/checkout",
    doc: emptyDoc("Checkout"),
  });
  return { person, installation, workspace: workspace!, repository, design };
}

const pullRequest = (
  repoId: number,
  {
    number = 12,
    state = "open",
    draft = false,
    merged = false,
    updatedAt = "2026-11-10T12:00:00Z",
    branch = "pz/checkout",
    headRepo = repoId,
  }: {
    number?: number;
    state?: string;
    draft?: boolean;
    merged?: boolean;
    updatedAt?: string;
    branch?: string;
    headRepo?: number | null;
  } = {},
) => ({
  number,
  state,
  draft,
  merged,
  updated_at: updatedAt,
  head: { ref: branch, sha: "abc123", repo: headRepo === null ? null : { id: headRepo } },
  base: { ref: "main", repo: { id: repoId } },
});

describe("what is let in", () => {
  test("a delivery signed with the App's secret is taken, and answered before the work is done", async () => {
    const installation = installOnOrg("signedco", []);

    const response = await t.app.request(
      "/v1/github/webhook",
      t.github.delivery("installation", installationPayload("created", installation, 1)),
    );

    expect(response.status).toBe(202);
    await t.backgroundDone();
    expect(await getWorkspaceByInstallation(t.db, installation.id)).not.toBeNull();
  });

  test("a wrong signature, no signature, or a body changed after signing is refused unread", async () => {
    const installation = installOnOrg("forgedco", []);
    const payload = installationPayload("created", installation, 1);
    const wrong = t.github.delivery("installation", payload, {
      secret: "not_the_secret_not_the_secret_not",
    });
    const unsigned = t.github.delivery("installation", payload);
    delete unsigned.headers["x-hub-signature-256"];
    const tampered = t.github.delivery("installation", payload);
    tampered.body = tampered.body.replace(String(installation.id), String(installation.id + 1));

    for (const request of [wrong, unsigned, tampered]) {
      const response = await t.app.request("/v1/github/webhook", request);
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("signature_invalid");
    }
    await t.backgroundDone();
    expect(await getWorkspaceByInstallation(t.db, installation.id)).toBeNull();
  });

  test("a delivery seen before is acknowledged and not processed again", async () => {
    const { repository, design } = await designInRepo("replayco");
    const review = {
      action: "submitted",
      repository: { id: repository.id },
      review: {
        state: "APPROVED",
        body: "Ship it",
        html_url: "https://x/r/1",
        user: { login: "rev" },
      },
      pull_request: pullRequest(repository.id),
    };

    const first = await deliver("pull_request_review", review, { id: "delivery-replayed" });
    const again = await deliver("pull_request_review", review, { id: "delivery-replayed" });

    expect(first.status).toBe(202);
    expect(again.status).toBe(204);
    expect(await eventsOf(design.id)).toHaveLength(1);
  });

  test("a delivery whose work failed is given back, so redelivering it runs it again", async () => {
    const installation = installOnOrg("flakyco", []);
    const payload = installationPayload("created", installation, 1);
    t.github.failNext(`/app/installations/${installation.id}`);

    await deliver("installation", payload, { id: "delivery-flaky" });
    expect(await getWorkspaceByInstallation(t.db, installation.id)).toBeNull();
    expect(t.logs.some((line) => line.event === "background_failed")).toBe(true);

    const redelivered = await deliver("installation", payload, { id: "delivery-flaky" });

    expect(redelivered.status).toBe(202);
    expect(await getWorkspaceByInstallation(t.db, installation.id)).not.toBeNull();
  });

  test("events and actions Ponzu does not act on are acknowledged and ignored", async () => {
    expect((await deliver("ping", { zen: "Keep it simple." })).status).toBe(204);
    expect((await deliver("push", { ref: "refs/heads/main" })).status).toBe(204);
    expect((await deliver("pull_request", { action: "labeled" })).status).toBe(204);
    expect((await deliver("installation", { action: "created" })).status).toBe(204);
    expect(t.logs.some((line) => line.reason === "malformed")).toBe(true);
  });

  test("a signed body that is not JSON, or headers that are not GitHub's, are refused", async () => {
    const notJson = t.github.delivery("installation", {});
    notJson.body = "not json";
    const signature = createHmac("sha256", t.github.credentials.webhookSecret)
      .update(notJson.body)
      .digest("hex");
    notJson.headers["x-hub-signature-256"] = `sha256=${signature}`;
    const noEvent = t.github.delivery("installation", {});
    delete noEvent.headers["x-github-event"];
    const oddDelivery = t.github.delivery("installation", {}, { id: "../../etc/passwd" });

    for (const request of [notJson, noEvent, oddDelivery]) {
      const response = await t.app.request("/v1/github/webhook", request);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalid_request");
    }
  });
});

describe("installation", () => {
  test("created: the workspace, its repos, and the installer as its admin", async () => {
    const owner = await t.signInAs({ login: "creator" });
    const installation = installOnOrg("createdco", [owner]);

    await deliver("installation", {
      ...installationPayload("created", installation, owner.github.id),
      repositories: [{ id: 1, full_name: "ignored/because-github-is-asked" }],
    });

    const workspace = await getWorkspaceByInstallation(t.db, installation.id);
    expect(workspace).toMatchObject({ githubLogin: "createdco", installedByUserId: owner.userId });
    expect(await reposOf(workspace!.id)).toEqual({ "createdco/app": true });
    expect(await listUserWorkspaces(t.db, owner.userId)).toMatchObject([
      { id: workspace!.id, role: "admin" },
    ]);
  });

  test("deleted before created, delivered in that order: nothing is made", async () => {
    const installation = installOnOrg("goneco", []);
    t.github.installations.pop();

    await deliver("installation", installationPayload("deleted", installation, 1));
    await deliver("installation", installationPayload("created", installation, 1));

    expect(await getWorkspaceByInstallation(t.db, installation.id)).toBeNull();
    const all = await t.db.select().from(workspaces);
    expect(all.find((workspace) => workspace.githubLogin === "goneco")).toBeUndefined();
  });

  test("deleted: the workspace stays with its designs, without the App or its repos", async () => {
    const { installation, workspace, design } = await designInRepo("deletedco");
    t.github.installations.splice(t.github.installations.indexOf(installation), 1);

    await deliver("installation", installationPayload("deleted", installation, 1));

    const after = (await t.db.select().from(workspaces)).find((w) => w.id === workspace.id)!;
    expect(after.installationId).toBeNull();
    expect(await reposOf(workspace.id)).toEqual({ "deletedco/app": false });
    expect(await getDesign(t.db, design.id)).not.toBeNull();
  });

  test("a created delivered after its deletion makes nothing come back", async () => {
    const { installation, workspace } = await designInRepo("latecreatedco");
    t.github.installations.splice(t.github.installations.indexOf(installation), 1);
    await deliver("installation", installationPayload("deleted", installation, 1));

    await deliver("installation", installationPayload("created", installation, 1));

    const after = (await t.db.select().from(workspaces)).find((w) => w.id === workspace.id)!;
    expect(after.installationId).toBeNull();
  });

  test("suspend and unsuspend, in either order, end as GitHub has it", async () => {
    const { installation, workspace } = await designInRepo("suspendco");
    const suspendedAt = () =>
      t.db
        .select()
        .from(workspaces)
        .then((rows) => rows.find((w) => w.id === workspace.id)!.suspendedAt);

    installation.suspendedAt = new Date("2026-11-10T09:00:00Z");
    await deliver("installation", installationPayload("suspend", installation, 1));
    expect(await suspendedAt()).toEqual(installation.suspendedAt);

    // Unsuspended on GitHub; the unsuspend arrives first, the old suspend after it.
    installation.suspendedAt = null;
    await deliver("installation", installationPayload("unsuspend", installation, 1));
    await deliver("installation", installationPayload("suspend", installation, 1));
    expect(await suspendedAt()).toBeNull();
  });

  test("new_permissions_accepted and installation_repositories bring the repo list up to date", async () => {
    const { installation, workspace } = await designInRepo("reposchangedco");
    installation.repositories.push({ id: id(), fullName: "reposchangedco/docs", access: {} });

    await deliver("installation_repositories", {
      action: "added",
      installation: { id: installation.id },
      repositories_added: [],
    });
    expect(await reposOf(workspace.id)).toEqual({
      "reposchangedco/app": true,
      "reposchangedco/docs": true,
    });

    installation.repositories.shift();
    await deliver("installation", installationPayload("new_permissions_accepted", installation, 1));
    expect(await reposOf(workspace.id)).toEqual({
      "reposchangedco/app": false,
      "reposchangedco/docs": true,
    });
  });

  test("installation_repositories for an installation GitHub does not have makes nothing", async () => {
    await deliver("installation_repositories", {
      action: "added",
      installation: { id: 999_999_001 },
    });
    expect(await getWorkspaceByInstallation(t.db, 999_999_001)).toBeNull();
  });
});

describe("repository", () => {
  test("renamed, privatized, a new default branch: the repo row follows GitHub", async () => {
    const { installation, workspace, repository } = await designInRepo("renameco");
    repository.fullName = "renameco/application";
    repository.private = false;
    repository.defaultBranch = "trunk";

    for (const action of ["renamed", "publicized"]) {
      await deliver("repository", {
        action,
        repository: { id: repository.id },
        installation: { id: installation.id },
      });
    }

    const [row] = (await t.db.select().from(repos)).filter((r) => r.workspaceId === workspace.id);
    expect(row).toMatchObject({
      fullName: "renameco/application",
      private: false,
      defaultBranch: "trunk",
    });
  });

  test("transferred to another account with the App: the repo and its designs move", async () => {
    const { installation, repository, design, person } = await designInRepo("fromco");
    const to = installOnOrg("toco", [person]);
    await syncGithub(t.deps, person.userId);
    installation.repositories.splice(0, 1);
    to.repositories.push({ ...repository, fullName: "toco/app" });

    await deliver("repository", {
      action: "transferred",
      repository: { id: repository.id },
      installation: { id: to.id },
    });

    const toWorkspace = await getWorkspaceByInstallation(t.db, to.id);
    expect((await getDesign(t.db, design.id))!.workspaceId).toBe(toWorkspace!.id);
  });

  test("deleted: marked removed, its design kept", async () => {
    const { installation, workspace, repository, design } = await designInRepo("repodeletedco");
    installation.repositories.splice(0, 1);

    await deliver("repository", {
      action: "deleted",
      repository: { id: repository.id },
      installation: { id: installation.id },
    });

    expect(await reposOf(workspace.id)).toEqual({ "repodeletedco/app": false });
    expect(await getDesign(t.db, design.id)).not.toBeNull();
  });

  test("a repo of an installation Ponzu does not know makes no rows", async () => {
    const stranger = installOnOrg("strangerco", []);

    await deliver("repository", {
      action: "renamed",
      repository: { id: stranger.repositories[0]!.id },
      installation: { id: stranger.id },
    });

    expect(await getWorkspaceByInstallation(t.db, stranger.id)).toBeNull();
  });
});

describe("who can reach a workspace", () => {
  test("member added and removed: the person is synced in and out", async () => {
    const { installation, workspace } = await designInRepo("collabco");
    const newcomer = await t.signInAs({ login: "newcomer-c" });
    installation.repositories[0]!.access[newcomer.github.id] = "read";

    await deliver("member", {
      action: "added",
      member: { id: newcomer.github.id, login: "newcomer-c" },
      repository: { id: installation.repositories[0]!.id },
    });
    expect((await listUserWorkspaces(t.db, newcomer.userId)).map((w) => w.id)).toEqual([
      workspace.id,
    ]);

    delete installation.repositories[0]!.access[newcomer.github.id];
    await deliver("member", {
      action: "removed",
      member: { id: newcomer.github.id, login: "newcomer-c" },
    });
    expect(await listUserWorkspaces(t.db, newcomer.userId)).toEqual([]);
  });

  test("organization member_removed and team membership changes sync the person named", async () => {
    const { installation, person } = await designInRepo("orgco");
    delete installation.repositories[0]!.access[person.github.id];

    await deliver("organization", {
      action: "member_removed",
      membership: { user: { id: person.github.id, login: "x" }, role: "member" },
      organization: { id: installation.account.id, login: "orgco" },
    });
    expect(await listUserWorkspaces(t.db, person.userId)).toEqual([]);

    installation.repositories[0]!.access[person.github.id] = "write";
    await deliver("membership", {
      action: "added",
      member: { id: person.github.id, login: "x" },
      team: { id: 1, slug: "design" },
    });
    expect(await listUserWorkspaces(t.db, person.userId)).toHaveLength(1);
  });

  test("someone who never signed in to Ponzu changes nothing, and fails nothing", async () => {
    const failures = () => t.logs.filter((line) => line.event === "background_failed").length;
    const before = failures();

    const response = await deliver("member", {
      action: "added",
      member: { id: 424_242, login: "not-a-ponzu-user" },
    });

    expect(response.status).toBe(202);
    expect(failures()).toBe(before);
  });
});

describe("github_app_authorization", () => {
  test("revoked: their GitHub token is forgotten and their next request signs them in again", async () => {
    const quit = await t.signInAs({ login: "quitter" });
    t.github.revokeTokens(quit.github.id);

    await deliver("github_app_authorization", {
      action: "revoked",
      sender: { id: quit.github.id, login: "quitter" },
    });

    expect(await getGithubUserToken(t.db, quit.userId)).toBeNull();
    const response = await t.app.request("/v1/me", { headers: quit.headers });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("session_unknown");
  });

  test("revoked, delivered after they signed in again: the new sign-in stands", async () => {
    const back = await t.signInAs({ login: "comeback" });

    await deliver("github_app_authorization", {
      action: "revoked",
      sender: { id: back.github.id, login: "comeback" },
    });

    expect(await getGithubUserToken(t.db, back.userId)).not.toBeNull();
    expect((await t.app.request("/v1/me", { headers: back.headers })).status).toBe(200);
  });
});

describe("pull requests, checks and reviews", () => {
  test("opened, ready, merged: the design follows and settles", async () => {
    const { repository, design } = await designInRepo("prco");
    const send = (action: string, pr: object) =>
      deliver("pull_request", { action, repository: { id: repository.id }, pull_request: pr });

    await send(
      "opened",
      pullRequest(repository.id, { draft: true, updatedAt: "2026-11-10T12:00:00Z" }),
    );
    expect(await getDesign(t.db, design.id)).toMatchObject({ prNumber: 12, prState: "draft" });

    await send(
      "ready_for_review",
      pullRequest(repository.id, { updatedAt: "2026-11-10T12:05:00Z" }),
    );
    await send("synchronize", pullRequest(repository.id, { updatedAt: "2026-11-10T12:06:00Z" }));
    expect(await getDesign(t.db, design.id)).toMatchObject({ prState: "open", status: "active" });

    await send(
      "closed",
      pullRequest(repository.id, {
        state: "closed",
        merged: true,
        updatedAt: "2026-11-10T12:10:00Z",
      }),
    );
    expect(await getDesign(t.db, design.id)).toMatchObject({
      prState: "merged",
      status: "settled",
    });
  });

  test("closed then reopened, delivered backwards: the reopen still wins", async () => {
    const { repository, design } = await designInRepo("reopenco");
    const send = (action: string, pr: object) =>
      deliver("pull_request", { action, repository: { id: repository.id }, pull_request: pr });

    await send("reopened", pullRequest(repository.id, { updatedAt: "2026-11-10T13:00:00Z" }));
    await send(
      "closed",
      pullRequest(repository.id, { state: "closed", updatedAt: "2026-11-10T12:30:00Z" }),
    );

    expect(await getDesign(t.db, design.id)).toMatchObject({ prState: "open", status: "active" });
  });

  test("a pull request from a fork, or on a branch no design owns, changes nothing", async () => {
    const { repository, design } = await designInRepo("forkco");

    await deliver("pull_request", {
      action: "opened",
      repository: { id: repository.id },
      pull_request: pullRequest(repository.id, { headRepo: 31_337 }),
    });
    await deliver("pull_request", {
      action: "opened",
      repository: { id: repository.id },
      pull_request: pullRequest(repository.id, { branch: "feature/other" }),
    });
    await deliver("pull_request", {
      action: "opened",
      repository: { id: 999_999_002 },
      pull_request: pullRequest(999_999_002),
    });

    expect(await getDesign(t.db, design.id)).toMatchObject({ prNumber: null, prState: null });
  });

  test("a failed check run or suite is news for the agent; a passing one is not", async () => {
    const { repository, design } = await designInRepo("checkco");
    const prs = [{ number: 12, head: { ref: "pz/checkout", repo: { id: repository.id } } }];
    const run = (conclusion: string) => ({
      action: "completed",
      repository: { id: repository.id },
      check_run: {
        name: "lint",
        conclusion,
        head_sha: "abc123",
        details_url: "https://ci.example/1",
        pull_requests: prs,
      },
    });

    await deliver("check_run", run("success"));
    await deliver("check_run", run("failure"));
    await deliver("check_suite", {
      action: "completed",
      repository: { id: repository.id },
      check_suite: {
        conclusion: "timed_out",
        head_sha: "abc123",
        app: { name: "GitHub Actions" },
        pull_requests: prs,
      },
    });

    const feed = await eventsOf(design.id);
    expect(feed.map((event) => [event.kind, event.priority, event.payload])).toEqual([
      [
        "check",
        "next",
        {
          source: "check_run",
          name: "lint",
          conclusion: "failure",
          url: "https://ci.example/1",
          headSha: "abc123",
          pullRequest: 12,
        },
      ],
      [
        "check",
        "next",
        {
          source: "check_suite",
          name: "GitHub Actions",
          conclusion: "timed_out",
          headSha: "abc123",
          pullRequest: 12,
        },
      ],
    ]);
  });

  test("a review is news for the agent, but not once the design is settled", async () => {
    const { repository, design } = await designInRepo("reviewco");
    const review = (state: string) => ({
      action: "submitted",
      repository: { id: repository.id },
      review: { state, body: "x".repeat(5_000), html_url: "https://gh/r", user: { login: "kim" } },
      pull_request: pullRequest(repository.id),
    });

    await deliver("pull_request_review", review("CHANGES_REQUESTED"));
    await deliver("pull_request", {
      action: "closed",
      repository: { id: repository.id },
      pull_request: pullRequest(repository.id, { state: "closed", merged: true }),
    });
    await deliver("pull_request_review", review("APPROVED"));

    const feed = await eventsOf(design.id);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: "review",
      priority: "next",
      payload: {
        state: "changes_requested",
        reviewer: "kim",
        url: "https://gh/r",
        pullRequest: 12,
      },
    });
    expect((feed[0]!.payload.body as string).length).toBe(4_000);
  });
});
