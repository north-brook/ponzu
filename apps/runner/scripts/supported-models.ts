import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelInfo, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Channel } from "../src/agent/channel.ts";

/*
 * What the pinned Claude Code offers an account (docs/cloud.md, "Models"): starts a session as
 * the runner does, asks `supportedModels()` and prints the answer, or writes it to the file
 * named by `--out`. No message is sent, so no turn runs: the list comes with the session's start.
 *
 *   ANTHROPIC_API_KEY=… bun apps/runner/scripts/supported-models.ts \
 *     --out apps/runner/src/agent/fixtures/supported-models.api-key.json
 *
 * Claude Code runs with an empty home and config folder, so the machine's own sign-in and
 * settings cannot change what it answers. It records how Claude Code was signed in, never the
 * credential.
 */

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const home = mkdtempSync(join(tmpdir(), "pz-models-"));
/** The session's input, which never gets a message. */
const inbox = new Channel<SDKUserMessage>();

const q = query({
  prompt: inbox,
  options: {
    cwd: home,
    settingSources: [],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      DISABLE_AUTOUPDATER: "1",
    },
  },
});
try {
  const models: ModelInfo[] = await q.supportedModels();
  const init = await q.initializationResult();
  const answer = {
    claudeCode: init.claude_code_version ?? null,
    recordedOn: new Date().toISOString().slice(0, 10),
    // How Claude Code was signed in: never the credential.
    account: {
      apiProvider: init.account.apiProvider ?? null,
      apiKeySource: init.account.apiKeySource ?? null,
      subscriptionType: init.account.subscriptionType ?? null,
    },
    models,
  };
  const text = `${JSON.stringify(answer, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
} finally {
  inbox.close();
  q.close();
  rmSync(home, { recursive: true, force: true });
}
