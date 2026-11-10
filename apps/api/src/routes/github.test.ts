import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authStates, listUserWorkspaces } from "@ponzu/db";
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

let nextId = 70_000;
const id = () => nextId++;

/** An installation on an organization whose members, the people given, can push to its repo. */
function installOnOrg(login: string, people: SignedInPerson[], name: string | null = null) {
  const installation: FakeInstallation = {
    id: id(),
    account: {
      id: id(),
      login,
      type: "Organization",
      name,
      members: people.map((person) => person.github.id),
    },
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

function installOnPerson(person: SignedInPerson): FakeInstallation {
  const installation: FakeInstallation = {
    id: id(),
    account: { id: person.github.id, login: person.github.login, type: "User" },
    repositorySelection: "all",
    repositories: [],
  };
  t.github.installations.push(installation);
  return installation;
}

const post = (path: string, person: SignedInPerson, body?: unknown) =>
  t.app.request(path, {
    method: "POST",
    headers: { ...person.headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("GET /v1/github/accounts and POST /v1/github/sync", () => {
  test("someone new: only their own account, not installed", async () => {
    const pia = await t.signInAs({ login: "pia", name: "Pia Park" });

    const response = await t.app.request("/v1/github/accounts", { headers: pia.headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [
        {
          githubAccountId: pia.github.id,
          login: "pia",
          name: "Pia Park",
          avatarUrl: "https://avatars.example/pia",
          kind: "personal",
          status: "not_installed",
          workspaceId: null,
          suspended: false,
          memberCount: null,
        },
      ],
    });
  });

  test("the accounts list is as of the last sync; a sync brings it up to date", async () => {
    const quin = await t.signInAs({ login: "quin" });
    const ray = await t.signInAs({ login: "ray" });
    installOnPerson(quin);
    installOnOrg("zebra-co", [quin]);
    installOnOrg("acme", [quin, ray], "Acme Inc");
    await post("/v1/github/sync", ray);

    const stale = await t.app.request("/v1/github/accounts", { headers: quin.headers });
    expect((await stale.json()).accounts).toHaveLength(1);

    const response = await post("/v1/github/sync", quin);

    expect(response.status).toBe(200);
    const { accounts } = await response.json();
    const workspaces = await listUserWorkspaces(t.db, quin.userId);
    const workspaceOf = (login: string) => workspaces.find((w) => w.githubLogin === login)!.id;
    // Their own first, then by name; a member count only for a ready organization.
    expect(accounts.map((a: any) => [a.login, a.name, a.kind, a.status, a.memberCount])).toEqual([
      ["quin", "Quin", "personal", "ready", null],
      ["acme", "Acme Inc", "org", "ready", 2],
      ["zebra-co", "zebra-co", "org", "ready", 1],
    ]);
    expect(accounts[0].workspaceId).toBe(workspaceOf("quin"));
    expect(accounts[1].workspaceId).toBe(workspaceOf("acme"));
  });

  test("a sync with a token GitHub refuses asks the person to sign in again", async () => {
    const sid = await t.signInAs({ login: "sid" });
    t.github.revokeTokens(sid.github.id);

    const response = await post("/v1/github/sync", sid);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("github_reauth_required");
  });

  test("both need a signed-in person", async () => {
    expect((await t.app.request("/v1/github/accounts")).status).toBe(401);
    expect((await t.app.request("/v1/github/sync", { method: "POST" })).status).toBe(401);
  });
});

describe("POST /v1/github/install-link", () => {
  test("a link to the App's install page with a sealed state, good for fifteen minutes", async () => {
    const tess = await t.signInAs({ login: "tess" });

    const response = await post("/v1/github/install-link", tess, { client: "mac" });

    expect(response.status).toBe(200);
    const { url, expiresAt } = await response.json();
    const link = new URL(url);
    expect(link.origin + link.pathname).toBe(
      "https://github.com/apps/ponzu-test/installations/new",
    );
    const state = link.searchParams.get("state")!;
    expect(state).toStartWith("pzv1.");
    expect(new Date(expiresAt).getTime()).toBe(t.clock.now() + 15 * 60_000);
    // The row is not in the link: only the API can open the state to find it.
    const rows = await t.db.select().from(authStates);
    const row = rows.find((candidate) => candidate.userId === tess.userId)!;
    expect(row).toMatchObject({ kind: "github_install", payload: { client: "mac" } });
    expect(url).not.toContain(row.id);
  });

  test("an account to suggest goes to GitHub as its target", async () => {
    const uma = await t.signInAs({ login: "uma" });

    const response = await post("/v1/github/install-link", uma, {
      client: "ios",
      githubAccountId: uma.github.id,
    });

    const link = new URL((await response.json()).url);
    expect(link.pathname).toBe("/apps/ponzu-test/installations/new/permissions");
    expect(link.searchParams.get("target_id")).toBe(String(uma.github.id));
  });

  test("a client it does not know is refused", async () => {
    const vic = await t.signInAs({ login: "vic" });
    const response = await post("/v1/github/install-link", vic, { client: "android" });
    expect(response.status).toBe(400);
  });
});

describe("GET /v1/github/setup", () => {
  async function installLink(person: SignedInPerson) {
    const response = await post("/v1/github/install-link", person, { client: "mac" });
    return new URL((await response.json()).url).searchParams.get("state")!;
  }

  const land = (query: Record<string, string>) =>
    t.app.request(`/v1/github/setup?${new URLSearchParams(query)}`);

  test("back from installing: confirmed with the person's own token, synced, and a way back", async () => {
    const wyn = await t.signInAs({ login: "wyn" });
    const state = await installLink(wyn);
    const installation = installOnOrg("setupco", [wyn], "Setup & <Co>");

    const response = await land({
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await response.text();
    const [workspace] = await listUserWorkspaces(t.db, wyn.userId);
    expect(workspace).toMatchObject({ githubLogin: "setupco", role: "admin" });
    expect(page).toContain("Ponzu is set up on Setup &amp; &lt;Co&gt;");
    expect(page).toContain(
      `href="ponzu://github/setup?result=installed&amp;workspace=${workspace!.id}"`,
    );
    expect(page).not.toContain("<script");
  });

  test("a state is good once: the same link again says no more than 'almost there'", async () => {
    const xia = await t.signInAs({ login: "xia" });
    const state = await installLink(xia);
    const installation = installOnOrg("replayco", [xia]);
    const query = { installation_id: String(installation.id), setup_action: "install", state };
    await land(query);

    const replayed = await land(query);

    expect(replayed.status).toBe(200);
    const page = await replayed.text();
    expect(page).toContain("Almost there");
    expect(page).toContain("ponzu://github/setup?result=pending");
  });

  test("a state that ran out changes nothing", async () => {
    const yuri = await t.signInAs({ login: "yuri" });
    const state = await installLink(yuri);
    const installation = installOnOrg("lateco", [yuri]);
    t.clock.advance(15 * 60_000);

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    expect(page).toContain("result=pending");
    expect(await listUserWorkspaces(t.db, yuri.userId)).toEqual([]);
  });

  test("an installation the person cannot reach is not theirs, whatever the query says", async () => {
    const zed = await t.signInAs({ login: "zed" });
    const stranger = await t.signInAs({ login: "stranger" });
    const theirs = installOnOrg("notyoursco", [stranger]);
    const state = await installLink(zed);

    const page = await (
      await land({ installation_id: String(theirs.id), setup_action: "install", state })
    ).text();

    expect(page).toContain("result=pending");
    expect(page).not.toContain("notyoursco");
    expect(await listUserWorkspaces(t.db, zed.userId)).toEqual([]);
    expect(t.logs.some((line) => line.event === "github_setup_unreachable")).toBe(true);
  });

  test("no state at all (installed from github.com): a gentle page and nothing written", async () => {
    const installation = installOnOrg("directco", []);

    const response = await land({
      installation_id: String(installation.id),
      setup_action: "install",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("result=pending");
  });

  test("a forged state, or garbage anywhere in the query, is the same gentle page", async () => {
    const forged = await land({
      installation_id: "1",
      setup_action: "install",
      state: "pzv1.a.b.c",
    });
    const garbage = await t.app.request(
      "/v1/github/setup?installation_id=<script>&setup_action=x&state=" + "z".repeat(2000),
    );
    const doubled = await t.app.request("/v1/github/setup?state=a&state=b&installation_id=1");

    for (const response of [forged, garbage, doubled]) {
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(page).toContain("result=pending");
      expect(page).not.toContain("<script>");
    }
  });

  test("an install that became a request to the organization's owners", async () => {
    const abe = await t.signInAs({ login: "abe" });
    const state = await installLink(abe);

    const page = await (await land({ setup_action: "request", state })).text();

    expect(page).toContain("Request sent");
    expect(page).toContain("result=requested");
  });

  test("someone whose GitHub token is dead is asked to sign in again", async () => {
    const bea = await t.signInAs({ login: "bea" });
    const state = await installLink(bea);
    const installation = installOnOrg("deadtokenco", [bea]);
    t.github.revokeTokens(bea.github.id);

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    expect(page).toContain("result=sign_in");
  });

  test("GitHub failing says so on the page, not as JSON", async () => {
    const cal = await t.signInAs({ login: "cal" });
    const state = await installLink(cal);
    const installation = installOnOrg("downco", [cal]);
    t.github.failNext("/user/installations");

    const response = await land({
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("result=failed");
  });
});
