import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { call, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * Your own agent (docs/cloud.md, "Your own agent"): an agent registers, the person allows it in
 * the app, it trades the code for tokens, and its MCP acts as the person through their own
 * routes, and only as far as they could.
 */

let t: TestApp;
let ws: Workspace;

beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", omar: "read" });
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;
const REDIRECT = "http://127.0.0.1:53123/callback";

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    "base64url",
  );
}

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

async function form(path: string, fields: Record<string, string>) {
  const response = await t.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** An agent's whole sign-in, allowed by `login` in the app. Answers its tokens. */
async function connect(login: string, name = "Claude Code") {
  const registered = await call(t, {}, "POST", "/v1/oauth/register", {
    client_name: name,
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  expect(registered.status).toBe(201);
  const clientId: string = registered.body.client_id;
  const { verifier, challenge } = await pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st8",
  });
  const page = await t.app.request(`/v1/oauth/authorize?${query}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const requestId = /agents\/connect\?request=(aga_[0-9a-z]+)/.exec(html)?.[1];
  expect(requestId).toBeDefined();

  const headers = await as(login);
  const shown = await call(t, headers, "GET", `/v1/agent-connections/requests/${requestId}`);
  expect(shown.body).toMatchObject({ name, redirectHost: "127.0.0.1:53123", loopback: true });
  const approved = await call(
    t,
    headers,
    "POST",
    `/v1/agent-connections/requests/${requestId}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
  const back = new URL(approved.body.redirectUrl);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("st8");

  const tokens = await form("/v1/oauth/token", {
    grant_type: "authorization_code",
    client_id: clientId,
    code: back.searchParams.get("code")!,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  });
  expect(tokens.status).toBe(200);
  expect(tokens.body.access_token).toMatch(/^pza_/);
  return { clientId, ...tokens.body } as {
    clientId: string;
    access_token: string;
    refresh_token: string;
  };
}

let nextId = 1;
async function mcp(token: string, method: string, params: Record<string, unknown> = {}) {
  const response = await t.app.request("/v1/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as any,
  };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const answered = await mcp(token, "tools/call", { name, arguments: args });
  expect(answered.status).toBe(200);
  const result = answered.body.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError ?? false };
}

describe("signing in", () => {
  test("the MCP's 401 says where its authorization server is, and both documents say the rest", async () => {
    const unauthed = await t.app.request("/v1/mcp", { method: "POST", body: "{}" });
    expect(unauthed.status).toBe(401);
    const said = unauthed.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(said)?.[1];
    expect(metadataUrl).toBeDefined();
    const resource = await t.app.request(new URL(metadataUrl!).pathname);
    const { authorization_servers } = (await resource.json()) as {
      authorization_servers: string[];
    };
    const server = await t.app.request("/.well-known/oauth-authorization-server");
    const metadata = (await server.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(authorization_servers[0]);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(String(metadata.token_endpoint)).toEndWith("/v1/oauth/token");
  });

  test("an allowed agent gets tokens; refreshing gives new ones and ends the old refresh token", async () => {
    const { clientId, access_token, refresh_token } = await connect("maya");
    expect((await mcp(access_token, "tools/list")).status).toBe(200);

    const refreshed = await form("/v1/oauth/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(access_token);
    const again = await form("/v1/oauth/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    // Sent twice, a refresh token revokes its whole grant.
    expect((await mcp(refreshed.body.access_token, "tools/list")).status).toBe(401);
  });

  test("a refused agent goes back with access_denied and no tokens", async () => {
    const registered = await call(t, {}, "POST", "/v1/oauth/register", {
      client_name: "Codex",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    });
    const { challenge } = await pkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: registered.body.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const html = await (await t.app.request(`/v1/oauth/authorize?${query}`)).text();
    const requestId = /request=(aga_[0-9a-z]+)/.exec(html)![1];
    const denied = await call(
      t,
      await as("maya"),
      "POST",
      `/v1/agent-connections/requests/${requestId}/deny`,
    );
    expect(new URL(denied.body.redirectUrl).searchParams.get("error")).toBe("access_denied");
    const twice = await call(
      t,
      await as("maya"),
      "POST",
      `/v1/agent-connections/requests/${requestId}/approve`,
      {},
    );
    expect(twice.status).toBe(404);
  });

  test("an agent's token opens the MCP and nothing else; revoking it in settings ends it", async () => {
    const { access_token } = await connect("maya", "Cursor");
    const me = await t.app.request("/v1/me", {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(me.status).toBe(401);

    const headers = await as("maya");
    const listed = await call(t, headers, "GET", "/v1/agent-connections");
    const grant = listed.body.find((g: { name: string }) => g.name === "Cursor");
    expect(grant).toBeDefined();
    expect(
      (await call(t, await as("omar"), "DELETE", `/v1/agent-connections/${grant.id}`)).status,
    ).toBe(404);
    expect((await call(t, headers, "DELETE", `/v1/agent-connections/${grant.id}`)).status).toBe(
      204,
    );
    expect((await mcp(access_token, "tools/list")).status).toBe(401);
  });
});

describe("the tools act as the person", () => {
  test("initialize names the agent on its grant; the tools are listed", async () => {
    const { access_token } = await connect("maya");
    const init = await mcp(access_token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.1.0" },
    });
    expect(init.body.result.serverInfo.name).toBe("ponzu");
    expect(init.body.result.instructions).toContain("Ponzu");
    const listed = await call(t, await as("maya"), "GET", "/v1/agent-connections");
    expect(listed.body.some((g: { client: string }) => g.client === "claude-code/2.1.0")).toBe(
      true,
    );

    const tools = (await mcp(access_token, "tools/list")).body.result.tools as { name: string }[];
    expect(tools.map((x) => x.name)).toEqual(
      expect.arrayContaining([
        "list_workspaces",
        "list_canvases",
        "create_canvas",
        "get_canvas",
        "send_message",
        "read_thread",
        "answer_question",
        "wait_for_activity",
      ]),
    );
  });

  test("an agent starts a canvas in the person's repo, reads it, and talks to Ponzu's agent", async () => {
    const { access_token } = await connect("maya");
    const workspacesText = (await tool(access_token, "list_workspaces")).text;
    expect(workspacesText).toContain(ws.repo.fullName);

    const created = await tool(access_token, "create_canvas", {
      repository: ws.repo.fullName,
      message: "A launch page for Fernwood",
    });
    expect(created.isError).toBe(false);
    const canvasId = /Created (cnv_[0-9a-z]+)/.exec(created.text)![1]!;

    const listed = await tool(access_token, "list_canvases", { workspace: ws.id });
    expect(listed.text).toContain(canvasId);

    const got = await tool(access_token, "get_canvas", {
      canvas: `https://ponzu.design/canvases/${canvasId}`,
    });
    expect(got.text).toContain(canvasId);
    expect(got.text).toContain("Page ");

    const sent = await tool(access_token, "send_message", {
      canvas: canvasId,
      text: "Warmer, please",
    });
    expect(sent.isError).toBe(false);
    const thread = await tool(access_token, "read_thread", { canvas: canvasId });
    expect(thread.text).toContain("A launch page for Fernwood");
    expect(thread.text).toContain("Warmer, please");
    await t.backgroundDone();
  });

  test("the person's own limits hold: a repo they can only read is refused in words", async () => {
    const { access_token } = await connect("omar");
    const created = await tool(access_token, "create_canvas", { repository: ws.repo.fullName });
    expect(created.isError).toBe(true);
    expect(created.text).toContain("can't start a canvas there");
    const unknown = await tool(access_token, "get_canvas", { canvas: "cnv_0000000000000000" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toBe("There is no such canvas.");
  });
});
