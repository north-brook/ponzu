/**
 * An agent at work in a design for as long as this runs: as "claude-code", over the server's MCP,
 * it claims the first page's boards with set_status and says so again every minute, so its
 * presence stays "working" (the canvas traces the boards, the title shimmers) without changing
 * anything in the design.
 *
 *   bun apps/mobile/perf/sim/agent.ts <ponzu port> <design folder>
 */
const [port, file] = process.argv.slice(2);
if (!port || !file) throw new Error("usage: agent.ts <ponzu port> <design folder>");
const url = `http://127.0.0.1:${port}/mcp`;
let session: string | null = null;
let id = 0;

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
  if (!body.result || body.result.isError)
    throw new Error(`${method} failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result;
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
// Kettle's Brand page and the phone corpus's loops, where the flows look; anything else, its whole tree.
const page = /kettle/.test(file) ? "pg_w2rbn" : /phone/.test(file) ? "pg_phone2" : undefined;
const tree = await tool("get_tree", { file, ...(page ? { id: page, depth: 1 } : {}) });
const boards = [...new Set(tree.match(/ab_[a-z0-9]+/g) ?? [])].slice(0, 8);
if (!boards.length) throw new Error(`no artboards in ${file}`);
for (;;) {
  await tool("set_status", { file, status: "measuring the phone", artboards: boards });
  console.log(`working on ${boards.join(", ")}`);
  await new Promise((r) => setTimeout(r, 60_000));
}
