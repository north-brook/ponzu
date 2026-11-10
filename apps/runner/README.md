# @ponzu/runner

The one long-lived process inside each design's sandbox. It runs Claude Code through the Agent
SDK with the canvas tools in-process, keeps the design in step with the API, writes what the
agent does to the thread and the design's state, and puts what people do back into the run.
[docs/cloud.md](../../docs/cloud.md) ("The runner", "Events", "Needs you", "Credentials" and
"The runner protocol") is its specification.

```sh
bun test apps/runner                 # everything, against the fakes, no network
bun run build                        # dist/, what the sandbox image installs
bun scripts/dev.ts                   # the runner on this machine with real Claude Code (below)
RUNNER_LIVE=1 ANTHROPIC_API_KEY=… bun test apps/runner/src/live.test.ts   # one real turn
```

## Layout

```
src/
  main.ts          the entry: reads the environment, wires the parts, handles SIGTERM
  env.ts           the environment, checked once (exactly one Claude credential)
  run.ts           Runner: events in, the thread and state out, the session's lifecycle
  prompt.ts        each event as the text the model receives
  steps.ts         each tool call as the working line ("Drawing "Pricing · B"")
  thread.ts        thread writes, coalesced
  state.ts         state reports and the heartbeat
  previews.ts      light and dark previews of the first page
  usage.ts         each turn's tokens, by model
  repo.ts          git's identity and credential helper, the clone and the branch
  credential.ts    git's credential helper (built as dist/git-credential.js)
  server.ts        POST /poke and GET /health
  agent/
    agent.ts       the Agent interface: start, send, reply, interrupt, a stream of events
    sdk.ts         ClaudeAgent, on the Agent SDK; the only file that knows the SDK
    scripted.ts    a scripted agent for tests
  api/
    protocol.ts    every body on the wire; the apps import the thread's types from here
    api.ts         RunnerApi, the runner's whole view of the API
    http.ts        RunnerApi over HTTP
    fake.ts        RunnerApi in memory, for tests and local runs
    fake-http.ts   the fake behind the protocol's routes
scripts/
  build.ts         dist/
  dev.ts           a local run against the fake API
deploy/
  ponzu-runner.service   the systemd unit template
```

## How it runs in a sandbox

The image installs `dist/` (say in `/opt/ponzu-runner`), runs `bun install --production` there
for playwright-core, and installs `ponzu-runner.service` with `{{BUN}}` and `{{RUNNER_DIR}}`
filled in. The unit waits for the environment file boat writes at every start
(`/run/ascii-secrets/env.sh`), exports it and starts `bun runner.js` as `user`. It restarts on
failure, except on exit 78, which means the environment is wrong and only a new start of the
sandbox can mend it. On SIGTERM the runner stops the turn, lets the agent's edits reach the
API, writes the final state and exits, within the unit's 20 seconds.

Tested on Bun 1.4.2 (the repo's) on macOS, and the built bundle uses only what Bun 1.3 has
(`Bun.serve`, `Bun.build`, `node:` modules). The image also needs:

- **Claude Code** at `/usr/local/bin/claude`, which boat's image has. The Agent SDK is pinned to
  `0.3.322`, which speaks to Claude Code `2.1.322`: they are released together, so the image's
  Claude Code and this pin move together, and the runner never runs the copy the SDK would
  download.
- **Chromium**: Playwright's headless shell (`bunx playwright@<the playwright-core version in
  dist/package.json> install --only-shell chromium`), named by `PONZU_CHROMIUM` or found by the
  renderer, and the fonts the boat spike lists.
- **git** 2.40 or later, for `password_expiry_utc`.

## Environment

| Variable | |
|---|---|
| `PONZU_API_URL` | `https://api.ponzu.design` |
| `PONZU_DESIGN_ID` | The design this sandbox works on. |
| `PONZU_RUNNER_TOKEN` | The runner token: the bearer on every call, good for this design only. |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Exactly one. With both the runner refuses to start: Claude Code would silently use the key and bill its account. |
| `PONZU_RUNNER_PORT` | The port `/poke` and `/health` listen on, on every interface. 4600 by default. |
| `PONZU_WORK_ROOT` | Where checkouts live. `~/work` by default: the repo in `~/work/<name>`, Scratch in `~/work/scratch`. |
| `PONZU_STATE_DIR` | What the runner keeps across restarts (usage totals). `~/.ponzu` by default. |
| `PONZU_CLAUDE` | The `claude` binary, when it is not `/usr/local/bin/claude`. |
| `PONZU_CHROMIUM` | The Chromium for screenshots and previews. |

Repo secrets arrive as more variables in the same file and pass through to Claude Code and its
tools. The agent's environment holds the runner token too: git's credential helper needs it,
and anything running as `user` could read it from the runner anyway.

## The port

`POST /poke` (204) means "there may be something to claim". It carries nothing and the runner
trusts nothing about it: it only starts a claim, which the runner makes to the API with its own
token. The runner also claims every minute without one. `GET /health` answers
`{ "ok": true, "state": "working" | "needs_you" | "idle" }`. boat's token-gated address for the
port is how the API reaches both.

## Running it here

`bun scripts/dev.ts` serves the fake API over HTTP on port 8790 and starts the runner against it
with real Claude Code (the `claude` on your PATH) in a fresh temporary folder, on Haiku unless
`PONZU_DEV_MODEL` says otherwise. Set exactly one Claude credential in its environment. Each
line you type is a message from Ada; `/answer <words>` answers the open question, `/stop`
stops the turn, `/quit` shuts the runner down. The thread prints as it is written. With
`--bundle` it runs `dist/runner.js` instead of the source.

Against a local API, run `bun src/main.ts` with `PONZU_API_URL` pointed at it and a runner
token it issued for the design.

## Claude Code's configuration

- `bypassPermissions`: a VM per design, running as the non-root `user`, with nobody to click
  "allow". AskUserQuestion, plan approval (ExitPlanMode) and any other prompt still reach
  `canUseTool` and become questions in the design's needs-you; the SDK's warning that
  `canUseTool` "will not be invoked" in this mode is about ordinary tool calls.
- `settingSources: ["project"]`: the repo's own CLAUDE.md, `.claude/settings.json` (hooks,
  permission rules), skills, commands and agents apply. The sandbox user's settings
  (`~/.claude`) do not, so boat's own skill and settings stay out.
- `strictMcpConfig`, with the repo's `.mcp.json` servers read by the runner and passed beside
  `ponzu`: the repo's MCP servers run without an approval prompt nobody could answer, and the
  servers boat puts in `~/.claude.json` do not.
- Ponzu's instructions are appended to the `claude_code` system prompt; the canvas tools are
  the in-process MCP server `ponzu`, always loaded rather than behind tool search.

**What a hostile repo can therefore do:** anything its hooks, MCP servers, skills or code can
do as `user` in the sandbox, which is what running its dev server could do anyway. That
reaches the Claude credential, a one-hour token for that one repository, the runner token
(this design's canvas, thread and events) and the repo's own secrets, and nothing of any
other design. The sandbox is the boundary (docs/cloud.md, "Security").
