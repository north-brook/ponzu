import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Register Ponzu's MCP server with an agent. Uses the agent's own CLI when
 * there is one, so we never hand-edit its config format.
 */
export async function installAgent(agent: string | undefined, opts: { url: string }) {
  switch (agent) {
    case "claude":
    case "claude-code":
      return run(
        ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "ponzu", opts.url],
        "Claude Code",
      );
    case "codex":
      return run(["codex", "mcp", "add", "ponzu", "--url", opts.url], "Codex");
    case "cursor":
      return cursor(opts.url);
    default:
      console.log(`Add Ponzu to an agent:

  ponzu install claude     Claude Code
  ponzu install codex      Codex
  ponzu install cursor     Cursor

Or point any MCP client at ${opts.url} (streamable HTTP) while \`ponzu serve\` runs,
or launch \`bunx ponzu mcp\` over stdio.`);
  }
}

async function run(cmd: string[], label: string) {
  const which = Bun.which(cmd[0]!);
  if (!which) {
    console.error(
      `${cmd[0]} isn't on your PATH. Run this yourself once it is:\n\n  ${cmd.join(" ")}`,
    );
    process.exit(1);
  }
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code === 0)
    console.log(`\nPonzu added to ${label}. Keep \`ponzu serve\` running while you design.`);
  process.exit(code);
}

async function cursor(url: string) {
  const path = join(homedir(), ".cursor", "mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(await readFile(path, "utf8"));
    } catch {
      console.error(`${path} isn't valid JSON; add this yourself:\n  "ponzu": { "url": "${url}" }`);
      process.exit(1);
    }
  }
  config.mcpServers = { ...config.mcpServers, ponzu: { url } };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Ponzu added to ${path}.`);
}
