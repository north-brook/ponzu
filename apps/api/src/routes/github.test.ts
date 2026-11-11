import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { authStates, listUserWorkspaces } from "@ponzu/db";
import { renderSetupPage } from "../github/setup-page.ts";
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
    // Who GitHub says can reach zebra-co is read beside the sync, which does not wait for it:
    // until then its count is not known.
    expect(accounts.map((a: any) => [a.login, a.name, a.kind, a.status, a.memberCount])).toEqual([
      ["quin", "Quin", "personal", "ready", null],
      ["acme", "Acme Inc", "org", "ready", 2],
      ["zebra-co", "zebra-co", "org", "ready", null],
    ]);
    expect(accounts[0].workspaceId).toBe(workspaceOf("quin"));
    expect(accounts[1].workspaceId).toBe(workspaceOf("acme"));

    await t.backgroundDone();
    const later = await t.app.request("/v1/github/accounts", { headers: quin.headers });
    expect((await later.json()).accounts.map((a: any) => [a.login, a.memberCount])).toEqual([
      ["quin", null],
      ["acme", 2],
      ["zebra-co", 1],
    ]);
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
  /** A state from an app that takes `scheme`'s links (Ponzu's unless said). */
  async function installLink(person: SignedInPerson, scheme: string | null = "ponzu") {
    const response = await post("/v1/github/install-link", person, {
      client: "mac",
      ...(scheme ? { scheme } : {}),
    });
    return new URL((await response.json()).url).searchParams.get("state")!;
  }

  const land = (query: Record<string, string>) =>
    t.app.request(`/v1/github/setup?${new URLSearchParams(query)}`);

  /** The app link the page opens by itself, or null when it opens none. */
  const opens = (page: string) => page.match(/<main [^>]*data-link="([^"]*)"/)?.[1] ?? null;

  test("back from installing: confirmed with the person's own token, synced, and handed back", async () => {
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
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await response.text();
    const [workspace] = await listUserWorkspaces(t.db, wyn.userId);
    expect(workspace).toMatchObject({ githubLogin: "setupco", role: "admin" });
    expect(page).toContain("Ponzu is set up on Setup &amp; &lt;Co&gt;");
    // It opens the app by itself, says so, and offers the link again only if nothing took it.
    expect(opens(page)).toBe(
      `ponzu://github/setup?result=installed&amp;workspace=${workspace!.id}`,
    );
    expect(page).toContain("Opening Ponzu…");
    expect(page).toContain("Ponzu has it. You can close this tab.");
    expect(page).toContain(
      `href="ponzu://github/setup?result=installed&amp;workspace=${workspace!.id}" data-retry>`,
    );
    expect(page).toContain("Open Ponzu</a>");
  });

  test("a state is good once: the same link again says no more than 'almost there', and opens nothing", async () => {
    const xia = await t.signInAs({ login: "xia" });
    const state = await installLink(xia);
    const installation = installOnOrg("replayco", [xia]);
    const query = { installation_id: String(installation.id), setup_action: "install", state };
    await land(query);

    const replayed = await land(query);

    expect(replayed.status).toBe(200);
    const page = await replayed.text();
    expect(page).toContain("Almost there");
    expect(opens(page)).toBeNull();
    expect(page).not.toContain("://github/setup");
  });

  test("a state that ran out changes nothing", async () => {
    const yuri = await t.signInAs({ login: "yuri" });
    const state = await installLink(yuri);
    const installation = installOnOrg("lateco", [yuri]);
    t.clock.advance(15 * 60_000);

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    expect(page).toContain("Almost there");
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

    expect(opens(page)).toBe("ponzu://github/setup?result=pending");
    expect(page).not.toContain("notyoursco");
    expect(await listUserWorkspaces(t.db, zed.userId)).toEqual([]);
    expect(t.logs.some((line) => line.event === "github_setup_unreachable")).toBe(true);
  });

  test("no state at all (installed from github.com, or its settings): a gentle page that opens nothing", async () => {
    const installation = installOnOrg("directco", []);

    for (const setup_action of ["install", "update"]) {
      const response = await land({ installation_id: String(installation.id), setup_action });
      expect(response.status).toBe(200);
      const page = await response.text();
      expect(page).toContain("Almost there");
      expect(page).toContain("Ponzu picks up what you set up on GitHub by itself.");
      // Nothing says which app this is: never a guess at one the person may not have.
      expect(opens(page)).toBeNull();
      expect(page).not.toMatch(/ponzu(-dev|-preview)?:\/\//);
      expect(page).not.toContain("Open Ponzu");
    }
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
      expect(page).toContain("Almost there");
      expect(opens(page)).toBeNull();
      expect(page).not.toContain("<script>a");
      expect(page.match(/<script/g)).toHaveLength(1);
    }
  });

  test("an install that became a request to the organization's owners", async () => {
    const abe = await t.signInAs({ login: "abe" });
    const state = await installLink(abe);

    const page = await (await land({ setup_action: "request", state })).text();

    expect(page).toContain("Request sent");
    expect(page).toContain("Ponzu shows the organization once one of its owners approves.");
    expect(opens(page)).toBe("ponzu://github/setup?result=requested");
  });

  test("someone whose GitHub token is dead is asked to sign in again", async () => {
    const bea = await t.signInAs({ login: "bea" });
    const state = await installLink(bea);
    const installation = installOnOrg("deadtokenco", [bea]);
    t.github.revokeTokens(bea.github.id);

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    expect(page).toContain("Sign in to Ponzu again");
    expect(opens(page)).toBe("ponzu://github/setup?result=sign_in");
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
    const page = await response.text();
    expect(page).toContain("Ponzu couldn't reach GitHub");
    expect(page).toContain('data-problem="true"');
    expect(opens(page)).toBe("ponzu://github/setup?result=failed");
  });

  test("the way back is to the app that asked: Ponzu Dev's links for Ponzu Dev", async () => {
    const dee = await t.signInAs({ login: "dee" });
    const state = await installLink(dee, "ponzu-dev");
    const installation = installOnOrg("previewco", [dee]);

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    const [workspace] = await listUserWorkspaces(t.db, dee.userId);
    expect(opens(page)).toBe(
      `ponzu-dev://github/setup?result=installed&amp;workspace=${workspace!.id}`,
    );
    expect(page).toContain("Opening Ponzu Dev…");
    expect(page).toContain("Open Ponzu Dev</a>");
    expect(page).not.toContain("ponzu://");
  });

  test("a Ponzu Preview built before the rename still asks with its own scheme, and gets it", async () => {
    const gus = await t.signInAs({ login: "gus" });
    const state = await installLink(gus, "ponzu-preview");
    const installation = installOnOrg("oldpreviewco", [gus]);

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    const [workspace] = await listUserWorkspaces(t.db, gus.userId);
    expect(opens(page)).toBe(
      `ponzu-preview://github/setup?result=installed&amp;workspace=${workspace!.id}`,
    );
    expect(page).not.toContain("ponzu://");
    expect(page).not.toContain("ponzu-dev://");
  });

  test("a build that takes no links: no link, and the page says Ponzu has it and closes as Ponzu comes forward", async () => {
    // A development build on a Mac, adding a second account from "set up another on GitHub":
    // the founder's install of 11 November, whose page offered ponzu:// to an app that wasn't it.
    const hal = await t.signInAs({ login: "hal" });
    const state = await installLink(hal, "none");
    const installation = installOnOrg("lennyco", [hal], "Lenny Learning");

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    expect(page).toContain("Ponzu is set up on Lenny Learning");
    expect(page).toContain("Ponzu has it. You can close this tab.");
    expect(page).toContain('data-closes="true"');
    expect(opens(page)).toBeNull();
    expect(page).not.toMatch(/ponzu(-dev|-preview)?:\/\//);
    // Nothing that would fail: no button, no "didn't open".
    expect(page).not.toContain("Open Ponzu");
    expect(page).not.toContain("didn't open");
  });

  test("an app that says nothing of its links is not taken for Ponzu", async () => {
    const ivy = await t.signInAs({ login: "ivy" });
    const state = await installLink(ivy, null);
    const installation = installOnOrg("quietco", [ivy], "Quiet Co");

    const page = await (
      await land({ installation_id: String(installation.id), setup_action: "install", state })
    ).text();

    expect(page).toContain("Ponzu is set up on Quiet Co");
    expect(page).toContain("Go back to Ponzu to carry on. You can close this tab.");
    expect(opens(page)).toBeNull();
    expect(page).not.toContain("ponzu://");
  });

  test("an app's scheme survives GitHub failing, and the query can't choose one", async () => {
    const eli = await t.signInAs({ login: "eli" });
    const state = await installLink(eli, "ponzu-dev");
    const installation = installOnOrg("devdownco", [eli]);
    t.github.failNext("/user/installations");

    const failed = await land({
      installation_id: String(installation.id),
      setup_action: "install",
      state,
      scheme: "javascript",
    });
    expect(failed.status).toBe(502);
    expect(opens(await failed.text())).toBe("ponzu-dev://github/setup?result=failed");

    // Without a state that says otherwise, the page links nowhere, whatever else is asked.
    const unclaimed = await (await land({ setup_action: "install", scheme: "evil" })).text();
    expect(opens(unclaimed)).toBeNull();
    expect(unclaimed).not.toContain("evil");
  });

  test("the page is as strict as it can be: its one script and one style sheet by hash, nothing else", async () => {
    const jo = await t.signInAs({ login: "jo" });
    const state = await installLink(jo);
    const installation = installOnOrg("strictco", [jo]);
    const response = await land({
      installation_id: String(installation.id),
      setup_action: "install",
      state,
    });
    const page = await response.text();
    const csp = response.headers.get("content-security-policy")!;

    const directives = Object.fromEntries(
      csp.split(";").map((part) => {
        const [name, ...values] = part.trim().split(/\s+/);
        return [name!, values];
      }),
    );
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'none'"]);
    expect(directives["form-action"]).toEqual(["'none'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("nonce-");
    expect(Object.keys(directives).sort()).toEqual(
      [
        "base-uri",
        "default-src",
        "form-action",
        "frame-ancestors",
        "script-src",
        "style-src",
      ].sort(),
    );

    // Exactly one inline script and one style element, and each hash is of exactly it.
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(directives["script-src"]).toEqual([await sha256(scripts[0]!)]);
    expect(directives["style-src"]).toEqual([await sha256(styles[0]!)]);
    // No inline handlers or style attributes, which the hashes would not allow anyway.
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).not.toMatch(/\sstyle=/i);
  });

  test("nothing from GitHub's redirect or an account's name puts markup or a foreign link on the page", async () => {
    const kai = await t.signInAs({ login: "kai" });
    const state = await installLink(kai);
    const hostile = `"><script>alert(1)</script><a href="https://evil.example">x</a><img src=x onerror=alert(2)>`;
    const installation = installOnOrg("hostileco", [kai], hostile);

    const response = await land({
      installation_id: String(installation.id),
      setup_action: "install",
      state,
      setup_url: "https://evil.example",
      redirect: "javascript:alert(3)",
    });
    const page = await response.text();

    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).not.toContain("<img");
    expect(page).not.toContain('<a href="https://evil.example"');
    expect(page).not.toContain("javascript:");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The only elements are the page's own, and every link on it is the app's.
    const tags = [...page.matchAll(/<([a-z][a-z0-9]*)[\s>]/g)].map((m) => m[1]!);
    expect([...new Set(tags)].sort()).toEqual(
      ["html", "head", "meta", "title", "style", "body", "header", "main", "svg", "g", "path"]
        .concat(["section", "h1", "p", "a", "script"])
        .sort(),
    );
    const hrefs = [...page.matchAll(/<(?:a|main) [^>]*(?:href|data-link)="([^"]*)"/g)].map(
      (m) => m[1]!,
    );
    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) expect(href).toStartWith("ponzu://github/setup?");
  });
});

describe("GET /v1/github/installs/:id", () => {
  const get = (path: string, person: SignedInPerson) =>
    t.app.request(path, { headers: person.headers });

  async function begin(person: SignedInPerson, scheme = "none") {
    const response = await post("/v1/github/install-link", person, { client: "mac", scheme });
    const { id, url } = await response.json();
    return { id: id as string, state: new URL(url).searchParams.get("state")! };
  }

  test("an app that takes no links hears how its install went by asking", async () => {
    const lou = await t.signInAs({ login: "lou" });
    const { id, state } = await begin(lou);
    expect(id).toStartWith("auth_");

    const waiting = await (await get(`/v1/github/installs/${id}`, lou)).json();
    expect(waiting).toMatchObject({ status: "waiting" });

    const installation = installOnOrg("askco", [lou]);
    await t.app.request(
      `/v1/github/setup?${new URLSearchParams({
        installation_id: String(installation.id),
        setup_action: "install",
        state,
      })}`,
    );

    const [workspace] = await listUserWorkspaces(t.db, lou.userId);
    expect(await (await get(`/v1/github/installs/${id}`, lou)).json()).toEqual({
      status: "settled",
      result: "installed",
      workspaceId: workspace!.id,
    });
  });

  test("every outcome is told, with no workspace but an installed one's", async () => {
    const may = await t.signInAs({ login: "may" });
    const { id, state } = await begin(may, "ponzu-dev");
    await t.app.request(
      `/v1/github/setup?${new URLSearchParams({ setup_action: "request", state })}`,
    );
    expect(await (await get(`/v1/github/installs/${id}`, may)).json()).toEqual({
      status: "settled",
      result: "requested",
      workspaceId: null,
    });
  });

  test("one nobody came back from runs out", async () => {
    const ned = await t.signInAs({ login: "ned" });
    const { id } = await begin(ned);
    t.clock.advance(15 * 60_000);
    // Signed in again: the session's own token has run out by now too.
    const again = await t.signInAs({ login: "ned" });
    expect(await (await get(`/v1/github/installs/${id}`, again)).json()).toEqual({
      status: "expired",
    });
  });

  test("someone else's install is not there, and an id that couldn't be one is refused", async () => {
    const ora = await t.signInAs({ login: "ora" });
    const pat = await t.signInAs({ login: "pat" });
    const { id } = await begin(ora);
    expect((await get(`/v1/github/installs/${id}`, pat)).status).toBe(404);
    expect((await get("/v1/github/installs/auth_nothing", pat)).status).toBe(404);
    expect((await get("/v1/github/installs/x%3Cscript%3E", pat)).status).toBe(400);
    expect((await t.app.request(`/v1/github/installs/${id}`)).status).toBe(401);
  });
});

describe("the schemes an install link may name", () => {
  test("Ponzu's, Ponzu Dev's, Ponzu Preview's (Ponzu Dev's earlier name) or none, recorded in the state; anything else is refused", async () => {
    const fay = await t.signInAs({ login: "fay" });
    for (const scheme of ["ponzu", "ponzu-preview", "ponzu-dev", "none", undefined]) {
      const response = await post("/v1/github/install-link", fay, { client: "mac", scheme });
      expect(response.status).toBe(200);
    }
    const rows = await t.db.select().from(authStates);
    const payloads = rows.filter((row) => row.userId === fay.userId).map((row) => row.payload);
    expect(payloads).toHaveLength(5);
    expect(payloads).toEqual(
      expect.arrayContaining([
        { client: "mac", scheme: "ponzu" },
        { client: "mac", scheme: "ponzu-preview" },
        { client: "mac", scheme: "ponzu-dev" },
        { client: "mac", scheme: "none" },
        // Not said: not known, never Ponzu's.
        { client: "mac", scheme: null },
      ]),
    );

    for (const scheme of [
      "javascript",
      "https",
      "http://evil.example/",
      "ponzu-preview://evil",
      "PONZU",
      "",
      "data",
      "file",
      "x-ponzu",
      "NONE",
    ]) {
      const response = await post("/v1/github/install-link", fay, { client: "mac", scheme });
      expect(response.status).toBe(400);
    }
  });

  test("the page links only to the scheme it is handed, and only one on the list", async () => {
    await expect(renderSetupPage({ kind: "pending" }, "javascript" as never)).rejects.toThrow();
    // Each scheme on the list is its own way back.
    for (const scheme of ["ponzu", "ponzu-dev", "ponzu-preview"] as const) {
      const { html } = await renderSetupPage({ kind: "requested" }, scheme);
      expect(html).toContain(`data-link="${scheme}://github/setup?result=requested"`);
    }
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${Buffer.from(digest).toString("base64")}'`;
}
