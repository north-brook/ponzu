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
image/             the sandbox image: its recipe, its bake, its checks (image/README.md)
```

## How it runs in a sandbox

[image/README.md](image/README.md) is the image: it installs `dist/` in `/opt/ponzu/runner` with
`bun install --production` there for playwright-core, the Bun this repo pins, the Claude Code
the Agent SDK pin speaks to (`0.3.322` with `2.1.322`: they are released together and move
together, and the runner never runs the copy the SDK would download), the Chrome Headless Shell
playwright-core pins, `packages/render`'s fonts, and `ponzu-runner.service` with `{{BUN}}` and
`{{RUNNER_DIR}}` filled in. The unit waits for the environment file boat writes at every start
(`/run/ascii-secrets/env.sh`), exports it and starts `bun runner.js` as `user`. It restarts on
failure, except on exit 78, which means only a new start of the sandbox can mend it: the
environment is wrong, the API revoked the runner token (the design was deleted or settled), or
a newer runner took over the design's lease. On SIGTERM, which only the runner gets
(`KillMode=mixed`), it stops the turn, lets the agent's edits reach the API, writes the final
state and exits, within the unit's 20 seconds; what is left of the agent's side is killed then.

In the image, Claude Code and the checkout's git run as a second user, `agent`, that cannot
read the runner's environment (`PONZU_CLAUDE` and `PONZU_GIT` are wrappers that switch to it),
and git's credential helper asks the runner over a socket instead of holding the runner token.
The canvas tools run in the runner's process, but a file the agent names to one (`write_html`
and `create_artboard` by path, `add_asset`, `export`) is read and written as `agent`, through
`PONZU_AS_AGENT` (`src/files.ts`): a path, or a link a repo committed, reaches only what the
agent could reach with its own tools, never the runner's environment or home.
git 2.40 or later is needed, for `password_expiry_utc`.

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
| `PONZU_CLAUDE` | The `claude` binary, when it is not `/usr/local/bin/claude`. The image's runs it as `agent`. |
| `PONZU_GIT` | The `git` the checkout runs, when it is not the one on the PATH. The image's runs it as `agent`. |
| `PONZU_AS_AGENT` | A command that runs its arguments as the agent's user; the tools read and write the agent's files through it. Unset, they use the runner's own access, which is right only where the agent is the runner's user. The image's is `sudo -u agent`. |
| `PONZU_GIT_SOCKET` | Where git's credential helper asks the runner. `$PONZU_STATE_DIR/git.sock` by default; `/run/ponzu/git.sock` in the image. |
| `PONZU_CHROMIUM` | The Chromium for screenshots and previews. |
| `PONZU_REPO_SECRETS` | The repo's secrets, `NAME:base64(value)` comma-separated. |

Repo secrets arrive packed in `PONZU_REPO_SECRETS`, so none is ever a variable of the runner's
own (a `BUN_OPTIONS` would load code into it before it starts, and a value is only base64 in
the file the unit sources). `agentEnv` unpacks them under the runner's own variables for Claude
Code, its tools and the checkout's git. The runner token is not passed on: the runner leaves it
out of the environment it gives Claude Code and the checkout's git, and git's credential helper
(`bun git-credential.js <socket>`) asks the runner, which asks the API with its token and lease.
The Claude credential is in the agent's environment, because Claude Code needs it. What that
exposes, and to whom, is under "What a hostile repo or a hostile comment can do" below.

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

- `bypassPermissions`: a VM per design, running as a non-root user (`agent`), with nobody to click
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

**What a hostile repo or a hostile comment can do.** A repo's hooks, MCP servers, skills and
code run as the agent's user in the sandbox (`agent` in the image). So does whatever the agent
is talked into: anyone whose words become a prompt (a person commenting on the design, anyone
reviewing its pull request, which on a public repo is anyone on GitHub, a check's log) can try
to make the agent run a command. Either way that reaches the Claude credential, a one-hour
token for that one repository (through the runner's socket) and the repo's own secrets, and
nothing of any other design. In the image it does not reach the runner token: `agent` cannot
read the runner's `/proc` or boat's environment file, and has no sudo, and the canvas tools
read and write the paths it names as `agent` (`PONZU_AS_AGENT`). The runner keeps the
exposure down where it can: other people's words reach the model quoted, under instructions
that quoted text never directs it; the runner token can only write what an agent could anyway
(a runner cannot write the API's own notices, such as a pull request's); and the lease means a
stolen token can stop this design's runner but not act beside it. docs/cloud.md ("Security")
has the whole threat and the hardening that remains.
