# @ponzu/runner

The one long-lived process inside each canvas's sandbox. It runs Claude Code through the Agent
SDK with Ponzu's tools in-process, keeps the canvas in step with the API, writes what the
agent does to the thread and the canvas's state, and puts what people do back into the run.
[docs/cloud.md](../../docs/cloud.md) ("The runner", "Events", "Needs you", "Credentials" and
"The runner protocol") is its specification.

```sh
bun test apps/runner                 # everything, against the fakes, no network
bun run build                        # dist/: the runner bundle the API serves to sandboxes
bun scripts/dev.ts                   # the runner on this machine with real Claude Code (below)
RUNNER_LIVE=1 ANTHROPIC_API_KEY=… bun test apps/runner/src/live.test.ts   # one real turn
```

## Layout

```
src/
  main.ts          the entry: reads the environment, wires the parts, handles SIGTERM
  supervise.ts     the supervisor ponzu-start runs: the runner as `ponzu`, restarts, SIGTERM
  bundle.ts        the bundle's hash and tgz, as the API inlines them (@ponzu/runner/bundle)
  version.ts       what the runner says it is: runner/<version>+<bundle>
  inflight.ts      the turn Claude Code took in, kept so a cut-off turn is picked up
  env.ts           the environment, checked once (exactly one Claude credential)
  run.ts           Runner: events in, the thread and state out, the session's lifecycle
  prompt.ts        each event as the text the model receives
  steps.ts         each tool call said: the working state ("Drawing "Pricing · B"", "Running
                   tests") and, past tense, the turn's record; never a command or a secret
  turn.ts          a turn's one thread item: its steps grouped after each message, its answer
  thread.ts        thread writes, coalesced
  state.ts         state reports and the heartbeat
  previews.ts      light and dark previews of the first page
  usage.ts         each turn's tokens, by model
  repo.ts          git's identity and credential helper, the clone and the branch
  credential.ts    git's credential helper (built as dist/git-credential.js)
  server.ts        POST /poke and GET /health, behind the port's bearer
  save/            what lives only on the disk, kept: checkpoints and restoring them
    checkpoints.ts the turn marker, saving after each turn, finding a rollback at start
    transcripts.ts the files that make a Claude session resumable, packed as the agent
    work.ts        work in progress: a repo's as a commit in a bundle, Scratch's as a tar, each
                   kept with the checkpoint and holding no secret
    shell.ts       running tar and git on the agent's side
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
  build.ts         dist/ and runner.tgz, `--outdir` for another folder
  tgz.ts           the tgz, the same bytes every time
  dev.ts           a local run against the fake API
image/             the sandbox image: its recipe, its build, its checks (image/README.md)
```

## How it runs in a sandbox

[image/README.md](image/README.md) is the image. It holds no runner: the Bun this repo pins,
the Claude Code the Agent SDK pin speaks to (they are released together with one patch number
and move together, by the Claude Code workflow's pull request, docs/cloud.md "Keeping Claude
Code current"; the runner never runs the copy the SDK would download),
playwright-core and the Chrome Headless Shell it pins, `packages/render`'s fonts, and the two
commands the API runs as root. The runner comes as a bundle: `scripts/build.ts` builds `dist/`
(`runner.js`, `supervise.js`, `git-credential.js`, `manifest.json`), packs it into a tgz that is
the same bytes every time, and writes `bundle.json` with its SHA-256. The API's build inlines it,
serves it at `GET /v1/runner/bundle`, and names its hash in every start's `PONZU_RUNNER_BUNDLE`,
so a runner change ships with the API.

At every start of the sandbox the API runs `ponzu-start`, detached, with the runner's
environment in that one command's env. It fetches the bundle when the disk lacks it, checks its
hash and that its `manifest.json` fits the image, and runs `supervise.js` under a lock, its
output and the runner's in `/var/log/ponzu/runner.log` rather than in Vercel's command log. The
supervisor starts `runner.js` as `ponzu` (group `agent`, `CAP_DAC_READ_SEARCH` to read Claude
Code's 0600 transcripts) and restarts it on failure, after 1, 2, 4 … 30 seconds, except on exit
0 or 78. 78 means only a new start of the sandbox can mend it: the environment is wrong, the API
revoked the runner token (the canvas was deleted or settled), or a newer runner took over the
canvas's lease. Before every stop the API runs `ponzu-stop`: SIGTERM to the supervisor, which
passes it to the runner; the runner stops the turn, lets the agent's edits reach the API,
reports its final state, saves a checkpoint and closes Claude Code, and the supervisor kills
what is left of its group after 20 seconds at most; then `sync`. Every wake boots the sandbox
from its snapshot, so every wake is a new runner process.

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
| `PONZU_CANVAS_ID` | The canvas this sandbox works on. |
| `PONZU_RUNNER_TOKEN` | The runner token: the bearer on every call, good for this canvas only. |
| `PONZU_PORT_TOKEN` | The bearer every request to the runner's port must carry. New at every start. |
| `PONZU_RUNNER_BUNDLE` | The SHA-256 of the bundle this start runs; the runner names it in `X-Ponzu-Client`. |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Exactly one. With both the runner refuses to start: Claude Code would silently use the key and bill its account. |
| `PONZU_RUNNER_PORT` | The port `/poke` and `/health` listen on, on every interface. 4600 by default. |
| `PONZU_WORK_ROOT` | Where checkouts live. `~/work` by default: the repo in `~/work/<name>`, Scratch in `~/work/scratch`. |
| `PONZU_STATE_DIR` | What the runner keeps across restarts: usage totals, the turn in flight (`turn.json`), and the marker of the last checkpoint the API confirmed (`checkpoint.json`). `~/.ponzu` by default; `/home/ponzu/.ponzu` in the image. |
| `CLAUDE_CONFIG_DIR` | Claude Code's config folder, where its transcripts are and where a checkpoint's are put back. `~/.claude` by default; `/home/agent/.claude` in the image. |
| `PONZU_CLAUDE` | The `claude` binary, when it is not `/usr/local/bin/claude`. The image's runs it as `agent`. |
| `PONZU_GIT` | The `git` the checkout runs, when it is not the one on the PATH. The image's runs it as `agent`. |
| `PONZU_AS_AGENT` | A command that runs its arguments as the agent's user; the tools read and write the agent's files through it. Unset, they use the runner's own access, which is right only where the agent is the runner's user. The image's is `sudo -u agent`. |
| `PONZU_GIT_SOCKET` | Where git's credential helper asks the runner. `$PONZU_STATE_DIR/git.sock` by default; `/run/ponzu/git.sock` in the image. |
| `PONZU_CHROMIUM` | The Chromium for screenshots and previews. |
| `PONZU_REPO_SECRETS` | The repo's secrets, `NAME:base64(value)` comma-separated. |

PostHog needs no variable here: the API's session says where each turn's trace goes (`analytics`),
or that it goes nowhere ([docs/analytics.md](../../docs/analytics.md), "Agent turns").

The image's `runner.json` sets the paths (`PONZU_CLAUDE`, `PONZU_GIT`, `PONZU_AS_AGENT`,
`PONZU_GIT_SOCKET`, `PONZU_WORK_ROOT`, `PONZU_STATE_DIR`, `CLAUDE_CONFIG_DIR`, `PONZU_CHROMIUM`);
the API's start command sets the rest.

Repo secrets arrive packed in `PONZU_REPO_SECRETS`, so none is ever a variable of the runner's
own (a `BUN_OPTIONS` would load code into it before it starts). `agentEnv` unpacks them under the runner's own variables for Claude
Code, its tools and the checkout's git. The runner token is not passed on: the runner leaves it
out of the environment it gives Claude Code and the checkout's git, and git's credential helper
(`bun git-credential.js <socket>`) asks the runner, which asks the API with its token and lease.
The Claude credential is in the agent's environment, because Claude Code needs it. What that
exposes, and to whom, is under "What a hostile repo or a hostile comment can do" below.

## The port

Vercel serves the runner's port (4600) at the sandbox's public `https://<sub>.vercel.run`
address, which anyone with the URL can reach, so every request must carry
`authorization: Bearer $PONZU_PORT_TOKEN`, compared in constant time; without it every route
answers 401. `POST /poke` (204) means "there may be something to claim". It carries nothing and
the runner trusts nothing about it: it only starts a claim, which the runner makes to the API
with its own token. The runner also claims every minute without one. `GET /health` answers
`{ started, state }`: `started` once the canvas is open, Claude Code is up and the claims run.

## Sleep, and what the disk keeps

docs/cloud.md ("The sandbox", "Saving the sandbox") is the specification.

- **After each turn** has settled, the runner saves a checkpoint: the Claude session's
  transcript and the work in progress (a repo's as a commit, never on the canvas's branch nor
  anywhere on GitHub, carried in a git bundle; Scratch's as an archive), both uploaded where no
  client reads them, under a turn marker the API keeps the highest of, then runs `sync`. Files
  over the size limits, or that look like or hold a secret (a `.env`, a key, a file with a repo
  secret's value in it), are left out and named. A part that cannot be saved (a transcript over
  64 MB) never stops the other, and the API keeps the stored one in its place (`keep`). Nothing
  is saved when nothing changed.
- **Before a sleep** the API runs `ponzu-stop`, and the runner's SIGTERM shutdown runs: it
  interrupts a running turn and says so in the thread, settles the replica and its outboxes,
  reports its final state, saves a checkpoint, closes Claude Code and pushes what GitHub lacks if
  it can in time. Whatever it claimed and did not acknowledge is claimed again by the next runner.
  Vercel's stop then snapshots the disk.
- **At start**, before Claude Code reads its transcript, a disk whose marker is behind the API's
  (a rollback) or has none (a new or recreated sandbox, or a snapshot that expired) gets the
  checkpoint back, never over anything newer, and the runner logs `sandbox_rollback` or
  `sandbox_rebuilt` as JSON and tells the API.
- **The pull request summary.** On a canvas with a checked-out repo the runner hosts
  `describe_pull_request` beside Ponzu's tools: the agent's own words on what its branch
  changes, which the API writes into the pull request's description.
- **The agent's pull request** (`src/pull-request-tools.ts`). Beside it, `open_pull_request`,
  `read_pull_request`, `mark_pull_request_ready`, `update_pull_request_branch`,
  `enable_auto_merge` and `merge_pull_request`: each asks the API, which acts on GitHub as the
  person the turn is for (docs/cloud.md, "The agent's pull request"). Each names the turn's event,
  the one whose message began the turn other than an edit, set as the turn begins and kept for
  it (none for a turn an edit or Ponzu's own note began); the API decides from it who
  that person is and whether the turn may merge. The tools that change the branch on GitHub push
  first, and merge and update send the commit the checkout is at.

## Running it here

`bun scripts/dev.ts` serves the fake API over HTTP on port 8790 and starts the runner against it
with real Claude Code (the `claude` on your PATH) in a fresh temporary folder, on Haiku unless
`PONZU_DEV_MODEL` says otherwise. Set exactly one Claude credential in its environment. Each
line you type is a message from Ada; `/answer <words>` answers the open question, `/stop`
stops the turn, `/quit` shuts the runner down. The thread prints as it is written. With
`--bundle` it runs `dist/runner.js` instead of the source.

Against a local API, run `bun src/main.ts` with `PONZU_API_URL` pointed at it and a runner
token it issued for the canvas. A local API that wakes canvases in real sandboxes needs `dist/`
(`bun run build`) for the bundle it serves, and an address a sandbox can reach.

## Claude Code's configuration

- `bypassPermissions`: a VM per canvas, running as a non-root user (`agent`), with nobody to click
  "allow". AskUserQuestion, plan approval (ExitPlanMode) and any other prompt still reach
  `canUseTool` and become questions in the canvas's needs-you; the SDK's warning that
  `canUseTool` "will not be invoked" in this mode is about ordinary tool calls.
- `settingSources: ["project"]`: the repo's own CLAUDE.md, `.claude/settings.json` (hooks,
  permission rules), skills, commands and agents apply. The sandbox user's settings
  (`~/.claude`) do not.
- `strictMcpConfig`, with the repo's `.mcp.json` servers read by the runner and passed beside
  `ponzu`: the repo's MCP servers run without an approval prompt nobody could answer, and no
  server in `~/.claude.json` does.
- Ponzu's instructions are appended to the `claude_code` system prompt; the canvas tools are
  the in-process MCP server `ponzu`, always loaded rather than behind tool search.

**What a hostile repo or a hostile comment can do.** A repo's hooks, MCP servers, skills and
code run as the agent's user in the sandbox (`agent` in the image). So does whatever the agent
is talked into: anyone whose words become a prompt (a person commenting on the canvas, anyone
reviewing its pull request, which on a public repo is anyone on GitHub, a check's log) can try
to make the agent run a command. Either way that reaches the Claude credential, a one-hour
token for that one repository (through the runner's socket) and the repo's own secrets, and
nothing of any other canvas. In the image it does not reach the runner token: `agent` cannot
read the supervisor's or runner's `/proc` or the runner's log, and has no sudo, and the canvas tools
read and write the paths it names as `agent` (`PONZU_AS_AGENT`). The runner keeps the
exposure down where it can: other people's words reach the model quoted, under instructions
that quoted text never directs it; the runner token can only write what an agent could anyway
(a runner cannot write the API's own notices, such as a pull request's); and the lease means a
stolen token can stop this canvas's runner but not act beside it. docs/cloud.md ("Security")
has the whole threat and the hardening that remains.
