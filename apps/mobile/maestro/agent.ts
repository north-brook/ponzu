/**
 * An agent's work for the activity flow: as "claude-code", over the server's
 * MCP, it creates a design in a temporary folder and adds three artboards,
 * so Activity has "Claude added 3 artboards" to show. Never the examples.
 *
 *   bun apps/mobile/maestro/agent.ts <ponzu port> <folder>
 */
const [port, folder] = process.argv.slice(2);
if (!port || !folder) throw new Error("usage: agent.ts <ponzu port> <folder>");
const url = `http://127.0.0.1:${port}/mcp`;
let session: string | null = null;
let id = 0;

/** One JSON-RPC call; the answer comes as JSON or as one server-sent event. */
async function rpc(method: string, params: Record<string, unknown> = {}, notify = false) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(notify ? {} : { id: ++id }) }),
  });
  session ??= res.headers.get("mcp-session-id");
  if (notify) return null;
  const text = await res.text();
  const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "{}");
  const body = JSON.parse(json) as { result?: { isError?: boolean; content?: { text: string }[] } };
  const result = body.result;
  if (!result || result.isError)
    throw new Error(`${method} failed: ${JSON.stringify(body).slice(0, 300)}`);
  return result;
}

const tool = async (name: string, args: Record<string, unknown>) =>
  (await rpc("tools/call", { name, arguments: args }))?.content?.map((c) => c.text).join("\n") ??
  "";

await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "claude-code", version: "1.0.0" },
});
await rpc("notifications/initialized", {}, true);
const file = `${folder}/Maestro.design`;
await tool("create_file", { path: file });
const fills = ["#ffc81e", "#111110", "#e8e4da"];
for (const [i, fill] of fills.entries()) {
  const made = await tool("create_artboard", {
    file,
    name: `Step ${i + 1}`,
    width: 390,
    height: 844,
  });
  const board = /ab_[a-z0-9]+/.exec(made)?.[0];
  if (!board) throw new Error(`no artboard in: ${made}`);
  await tool("update_styles", { file, updates: [{ ids: [board], style: { background: fill } }] });
}
console.log(`Claude added ${fills.length} artboards to ${file}`);
