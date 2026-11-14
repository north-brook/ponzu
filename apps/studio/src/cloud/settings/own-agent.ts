/*
 * Settings › Agents, "Your own agent" (docs/cloud.md): where Ponzu's MCP is, and how each coding
 * agent adds it. The URL is the API's own, so a dev build shows dev's.
 */

/** Ponzu's MCP on the API the app talks to: `https://api.ponzu.design/v1/mcp`. */
export function mcpUrlOf(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/mcp`;
}

/** The Claude Code plugin, from this repo's marketplace: the MCP with Ponzu's skills. */
export const CLAUDE_PLUGIN = [
  "claude plugin marketplace add north-brook/ponzu",
  "claude plugin install ponzu@ponzu",
] as const;

/** Claude Code without the plugin: the MCP alone. */
export function claudeMcpAdd(url: string): string {
  return `claude mcp add --transport http ponzu ${url}`;
}

/**
 * Codex, as its CLI takes a streamable HTTP server (`codex mcp add <name> --url <url>`), then
 * its OAuth sign-in (`codex mcp login <name>`).
 */
export function codexMcpAdd(url: string): readonly string[] {
  return [`codex mcp add ponzu --url ${url}`, "codex mcp login ponzu"];
}

/**
 * Cursor's one-click install link: it opens Cursor, which asks to add the server
 * (`cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64 JSON>`).
 */
export function cursorInstallLink(url: string): string {
  const config = btoa(JSON.stringify({ url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=ponzu&config=${encodeURIComponent(config)}`;
}
