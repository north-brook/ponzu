import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NOW } from "../gallery/fixtures.ts";
import { connectedAgents } from "../gallery/setup-fixtures.ts";
import { TipProvider } from "../ui/tooltip.tsx";
import { type ConnectedAgent, connectedLine, OwnAgent, type OwnAgentProps } from "./agents.tsx";
import { claudeMcpAdd, codexMcpAdd, cursorInstallLink, mcpUrlOf } from "./own-agent.ts";

/*
 * Settings › Agents, "Your own agent" (docs/cloud.md): Ponzu's MCP on the API this app talks
 * to, each coding agent's way to add it, and the agents connected.
 */

const ignore = () => {};
const URL_ = "https://api.ponzu.design/v1/mcp";

const html = (over: Partial<OwnAgentProps> = {}) =>
  renderToStaticMarkup(
    <TipProvider>
      <OwnAgent
        mcpUrl={URL_}
        agents={connectedAgents}
        onCopy={ignore}
        onOpenLink={ignore}
        onRevoke={ignore}
        now={NOW}
        {...over}
      />
    </TipProvider>,
  );

test("the MCP is the API's own, so a dev build shows dev's", () => {
  expect(mcpUrlOf("https://api.ponzu.design")).toBe(URL_);
  expect(mcpUrlOf("http://localhost:8787/")).toBe("http://localhost:8787/v1/mcp");
});

test("each coding agent's commands name the server and its URL", () => {
  expect(claudeMcpAdd(URL_)).toBe(`claude mcp add --transport http ponzu ${URL_}`);
  expect(codexMcpAdd(URL_)).toEqual([`codex mcp add ponzu --url ${URL_}`, "codex mcp login ponzu"]);
});

test("Cursor's link carries the server as base64 JSON", () => {
  const link = new URL(cursorInstallLink(URL_));
  expect(link.protocol).toBe("cursor:");
  expect(link.host).toBe("anysphere.cursor-deeplink");
  expect(link.pathname).toBe("/mcp/install");
  expect(link.searchParams.get("name")).toBe("ponzu");
  expect(JSON.parse(atob(link.searchParams.get("config")!))).toEqual({ url: URL_ });
});

test("the section says what it's for, with the URL and every agent's way in", () => {
  const shown = html();
  expect(shown).toContain('aria-label="Your own agent"');
  expect(shown).toContain(
    "Use your canvases from Claude Code, Codex, Cursor or T3 Code: hand work to Ponzu&#x27;s agent, or drive a canvas yourself.",
  );
  expect(shown).toContain(URL_);
  expect(shown).toContain("claude plugin marketplace add north-brook/ponzu");
  expect(shown).toContain("claude plugin install ponzu@ponzu");
  expect(shown).toContain(`codex mcp add ponzu --url ${URL_}`);
  expect(shown).toContain("Add to Cursor");
  expect(shown).toContain("It runs Claude Code and Codex, so either setup above covers it.");
});

test("each connected agent has its mark, when it connected and was last used, and Revoke", () => {
  const shown = html();
  expect(shown).toContain('aria-label="Connected agents"');
  for (const name of ["Claude Code", "Codex", "Cursor"]) expect(shown).toContain(name);
  // claude-code/… is Claude's mark, codex… OpenAI's; one that never said is the plain dot.
  expect(shown).toContain('aria-label="Claude"');
  expect(shown).toContain('aria-label="OpenAI"');
  expect(shown).toContain('aria-label="Agent"');
  expect(shown.match(/>Revoke</g)).toHaveLength(3);
});

test("a connected agent's line says when, and whether it has been used", () => {
  const used: ConnectedAgent = {
    id: "agt_1",
    name: "Claude Code",
    client: "claude-code/2.1.0",
    createdAt: "2026-11-02T12:00:00Z",
    lastUsedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
  };
  expect(connectedLine(used, NOW)).toBe("Connected Nov 2 · last used 3 hours ago");
  expect(connectedLine({ ...used, lastUsedAt: null }, NOW)).toBe("Connected Nov 2 · not used yet");
});

test("with none connected it says how one connects", () => {
  expect(html({ agents: [] })).toContain("None yet.");
  expect(html({ agents: null })).not.toContain(">Revoke<");
});
