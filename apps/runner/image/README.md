# The sandbox image

Every design's sandbox starts from one boat.dev saved snapshot: boat's Ubuntu 24.04 base with
what the runner needs on top. This folder is how it is made, checked and tried.
[docs/cloud.md](../../../docs/cloud.md) ("The sandbox", "The runner", "Rendering") says why
each piece is there; this README says what is in the image and how to make it.

It lives with the runner because everything in it is pinned by the runner: its build, its
unit, the Claude Code its Agent SDK speaks to, the Chromium its renderer's playwright-core
downloads. `packages/sandbox` stays a provider library that knows nothing of what runs inside.

```
provision.sh     the recipe: run once, as root, in a fresh sandbox
bun.json         the Bun the repo pins (package.json's packageManager) and its zip's hash
recipe.ts        the pins, the folder provision.sh runs from, the snapshot's name
bake.ts          bake, verify, list and prune
checks.ts        the acceptance checks
trial.ts         a sandbox from the image with the runner's fake API beside the runner
e2e.ts           the runner for real: a turn, wakes, a repo checkout and push
sandbox/         what those run inside a sandbox (the fake API, a screenshot)
current.json     the last snapshot baked: name, inputs hash, date, size, pins
```

## What is in the image

| | Where | Why |
|---|---|---|
| Bun 1.4.2 | `/opt/ponzu/bun/<version>/bun`, `/opt/ponzu/bin/bun` | The runner's. boat's own Bun 1.3.14 (`/usr/local/bin/bun`) hangs renders in a long-lived process, so it stays where it is and the unit names ours. The zip's SHA-256 is checked. |
| The runner | `/opt/ponzu/runner` | `apps/runner/dist` with `bun install --production` (playwright-core only). Owned by root. |
| Claude Code 2.1.322 | `/usr/local/bin/claude` | The version the Agent SDK pin (0.3.322) speaks to. Its manifest gives the linux-x64 binary's hash; boat's base ships exactly that binary today, so it is kept, and installed from npm when the hash differs. |
| Chrome Headless Shell 156.0.8078.4 | `/opt/ponzu/browsers` | What playwright-core 1.64.1 pins, installed with its own CLI. The runner's `PONZU_CHROMIUM` names it. Not boat's Google Chrome. |
| Fonts | `/usr/share/fonts`, `/usr/local/share/fonts/ponzu` | Exactly `packages/render/sandbox-fonts.json`: its apt packages with no recommended extras, and its downloads with their hashes checked. boat's Droid Sans Fallback is removed: it was the one other CJK font, and fallback goes by what is installed. Not `playwright install --with-deps`, whose fonts fontconfig would prefer over Noto. |
| The `agent` user | `/home/agent`, checkouts in `/home/agent/work` | Claude Code, its tools and the checkout's git run as `agent`: no sudo, no docker, no way into `/home/user`. See "Two users". |
| The runner's unit | `/etc/systemd/system/ponzu-runner.service` and `.d/image.conf` | The template from `apps/runner/deploy` with its placeholders filled, enabled; the drop-in adds where things are and the agent's user apart. |
| A record | `/opt/ponzu/image.json` | The inputs hash and the versions, for people and the checks. |

Removed or kept out: nothing of boat's account reaches a sandbox (it is created `noEnv`, so
boat's GitHub login, AI logins and account token are absent; the checks confirm `gh` is logged
out and boat's config holds no credential). The other agents' configurations boat writes to
`/home/user` at every start (Codex, Kimi, opencode, its `computer` MCP server) hold no
credential and are out of the agent's reach; deleting them would not last, since boat writes
them again at the next start. No secret is ever part of a bake: the bake sandbox has no
environment at all.

The snapshot is 500 MiB (what differs from boat's base); `/opt/ponzu` is 374 MiB of it, most of
it the headless shell (about 250 MiB) and Bun (95 MiB); the fonts are most of the rest.

## Two users

The runner runs as `user` (boat's, which has sudo) and starts everything on the agent's side
through `/opt/ponzu/libexec/as-agent`: `sudo -u agent` with the caller's environment but the
runner token, `HOME=/home/agent`, a `PATH` that puts our Bun first, and `umask 002`.

- **Claude Code** is `agent-claude` (`PONZU_CLAUDE`), so its tools, the repo's hooks and MCP
  servers and the dev server it starts are all `agent`'s processes.
- **The checkout's git** is `agent-git` (`PONZU_GIT`): the clone, the branch and the global git
  config (author, committer, credential helper) are `agent`'s.
- **git's credential helper** asks the runner over `/run/ponzu/git.sock` (`PONZU_GIT_SOCKET`,
  mode 0660, group `agent`), and the runner asks the API with its own token and lease. The
  agent's side never holds the runner token: the runner leaves it out of the environment it
  hands on, and `as-agent` removes it again.
- **The runner reads what the agent writes** through `CAP_DAC_READ_SEARCH` (Claude Code keeps
  its transcripts 0600; the runner reads them to resume a session, and reads the files the
  agent names for `write_html` and `add_asset`). sudo drops the capability for the agent's side.
  The unit's group is `agent` with `UMask=0002`, so what the runner writes into the checkout
  (exports) is the agent's to change.
- What `agent` cannot do, and the checks confirm: read `/proc/<runner>/environ`, read boat's
  environment file (`/run/ascii-secrets/env.sh`, 0600 `user`), list `/home/user`, `sudo`, or use
  docker. No process of `agent`'s holds `PONZU_RUNNER_TOKEN`.

What is not done yet, precisely:

- **The Claude credential is still in the agent's environment.** Claude Code needs it, and
  anything running as `agent` can read it from `/proc`. Closing that is the egress proxy
  (docs/cloud.md, Hardening).
- **The repo's secrets** are in the agent's environment by design: they are for its tools.
- **Egress is open** for `agent`. boat has no network rules; per-uid `iptables` rules work
  (boat spike) but are not in snapshots, so the runner or a unit would have to apply them at
  every boot. Not done.
- **No docker for the agent.** `agent` is not in the `docker` group (that group is root). A
  repo whose dev setup needs docker will not run until there is a rootless docker or a broker.
- **boat's desktop stack still runs** (lightdm, Sunshine on localhost, Moonlight web on `*:8090`,
  CUPS, avahi). Each wants its own credential, which `agent` cannot read, but they are local
  surface and memory (about 0.8 GB of the 3.9 GB is in use at idle). Masking them is untried:
  boat's computer-use feature, which Ponzu does not use, depends on them.
- **boat's agent server** listens on `*:8911`; without the token it keeps in its own
  environment it answered 404 to what was tried. Not audited further.
- **The runner's user still has sudo**, so anything that takes over the runner process is root.
  A runner user of its own with only `sudo -u agent` would close that.

## Bake

```sh
bun apps/runner/image/bake.ts                 # BOAT_API_KEY in the environment
```

It builds `apps/runner/dist` from this checkout (with the bundle's smoke test), hashes the
recipe, the pins and the dist into the snapshot's name (`ponzu-runner-<12 hex>`), and stops
there if a snapshot of that name is already saved. Otherwise it creates a sandbox (no
environment), uploads the folder, runs `provision.sh` (about 25 s), runs the image checks,
saves the snapshot (about 9 s), destroys the sandbox, and checks again in a new sandbox made
from the snapshot. A snapshot that fails there is deleted. One that passes is written to
`current.json` and printed as `PONZU_SANDBOX_SNAPSHOT=<name>`. A bake uses two of boat's starts.

```sh
bun apps/runner/image/bake.ts --force         # bake even so
bun apps/runner/image/bake.ts verify [name]   # check a saved snapshot from a new sandbox
bun apps/runner/image/bake.ts list
bun apps/runner/image/bake.ts prune --keep 3  # delete all but the newest three and current
```

**How the API learns the image.** `PONZU_SANDBOX_SNAPSHOT` in the API's environment names the
snapshot new sandboxes are created `from`; `current.json` is the record of the last bake for
people, and the value to set. Baking does not change the API: set the variable and deploy.
Sandboxes already made keep their image.

## The checks

In the bake sandbox, then in one made from the snapshot; each is a hard failure:

- the versions are the pinned ones (Bun, and the Bun the unit starts; Claude Code and its
  binary's hash; the headless shell; playwright-core);
- `packages/render`'s stand-in font test passes there with nothing skipped (a family the image
  lacks is a skip, so a skip fails);
- a screenshot of a small artboard in the headless shell with its sandbox on, every renderer
  under seccomp in its own PID namespace;
- the unit is enabled and filled in; and, from the snapshot, active after boot with `/health`
  answering through the sandbox's token-gated address;
- the agent's user cannot read the runner's environment or token (above);
- nothing secret is on disk: the shapes of an Anthropic key or Claude token, a boat key or
  address token, a GitHub token, a Neon or WorkOS key or a runner token in every file a snapshot
  keeps (text and binary; not boat's Docker store, `/var/run`, which is the `/run` tmpfs that
  holds the environment, nor binaries of boat's base that hold a GitHub-token-shaped string in
  compiled code: three trees of other agents' vendored binaries, and `gh` and VS Code's Copilot
  as boat's lazy-restore store mirrors them), and private keys where anything of ours is
  written (the base's toolchains are full of test keys; the machine's own SSH, snakeoil and
  Sunshine keys are boat's). The exceptions are listed in `checks.ts`, each with its reason.

## Try it

```sh
bun apps/runner/image/e2e.ts scratch    # BOAT_API_KEY, ANTHROPIC_API_KEY
bun apps/runner/image/e2e.ts repo       # also GITHUB_TEST_REPO, GITHUB_APP_*, E2E_PERSON
```

`trial.ts` makes a sandbox from the snapshot with the environment the API will give it
(`PONZU_API_URL` pointing at the runner's fake API on localhost, `PONZU_DESIGN_ID`,
`PONZU_RUNNER_TOKEN` and the Claude credential, as boat `env`), runs `sandbox/fake-api.ts` there
as a unit of its own that starts before the runner at every boot, and drives it from this
machine through the sandbox's addresses. `scratch` sends a message, checks what the fake API
recorded (the artboard committed; a started notice, a work line and assistant text in the
thread; working, then idle; usage; light and dark previews), pulls the previews back, runs the
isolation and secrets checks with the real credential in the environment, then stops and
resumes the sandbox, warm and cold, timing each wake. `repo` mints a one-hour installation token
for the test repository, hands it to the fake API's git-credential answer, has the agent commit
a file and push the `pz/` branch, checks the commit's author and committer on GitHub, and
deletes the branch.

## For the lifecycle

**Create** a design's sandbox `from` `PONZU_SANDBOX_SNAPSHOT`, size `small`, `noEnv` (the
provider always sets it), with `ports: [4600]` (the runner; add the repo's dev server ports if
people should reach them) and this `env`, which is the only place secrets go:

| | |
|---|---|
| `PONZU_API_URL` | `https://api.ponzu.design` |
| `PONZU_DESIGN_ID` | the design |
| `PONZU_RUNNER_TOKEN` | a runner token for that design |
| `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | exactly one |
| the repo's secrets | as they are named |

Nothing else is needed: the unit's drop-in sets where the image put things. The env cannot
change on a running sandbox; a resume that sends a new `env` is always a cold start.

**The runner** listens on 4600 on every interface: `GET /health` and `POST /poke` through the
address `create` returned (`address.headers`, the `_port_auth` cookie). It starts at every boot
by itself (the unit is enabled and waits for boat's environment file).

**The unit and exit codes.** `Restart=on-failure` with `RestartSec=3` and no start limit:

| Exit | What it means | systemd |
|---|---|---|
| 0 | SIGTERM: the runner stopped the turn, let edits reach the API and reported its state | stays stopped until the next boot or `systemctl start` |
| 78 | the environment is wrong, the token was revoked (design deleted or settled), or a newer runner took the lease | stays stopped (`RestartPreventExitStatus=78`); only a new start of the sandbox, which for a new env means a cold one, brings it back |
| anything else, or a crash | | restarted after 3 s, for as long as the sandbox is awake |

`systemctl stop ponzu-runner` sends SIGTERM to the runner alone (`KillMode=mixed`) and kills
what is left after 20 s. A warm stop freezes the machine: the runner kept the same process
across both warm wakes measured, and was not signalled. Whether boat signals anything before a
stop that turns cold could not be read back (the journal of the boot before is not kept), so
an API that wants the final state reported and the edits settled before a long sleep should
`systemctl stop ponzu-runner` through `exec` before it stops the sandbox.

**How long each start takes**, measured from a Mac in the US against boat's EU hosts, on
`small`, with `ponzu-runner-cac2ee15017d`: this recipe's bake of the runner as it was before the
API's runner protocol landed (`current.json` names the bake of what is on `cloud` now, the same
recipe and 500 MiB, which passed the same checks). "/health" is the runner answering
through its address; "first text" is the first words of the reply to a message sent as soon as
the sandbox answered, which is what a person waits for.

| Start | /health after the call | First text after the call | Runs |
|---|---|---|---|
| Create from the snapshot | 3.6, 3.9, 4.4, 4.7, 6.2, 6.2, 6.7, 7.4, 11.6, 11.9 s | not measured: a first turn draws | 10 |
| Warm resume (stopped a minute) | 0.57, 0.57, 0.69, 0.81, 0.99 s | 1.8, 2.0, 2.1, 2.1, 2.3 s | 5 |
| Cold resume (stopped 11 minutes) | 4.8, 5.3, 5.4, 5.6, 6.3, 7.4, 7.8 s | 8.0, 8.1, 11.6 s | 7 / 3 |

A warm resume thaws the same machine: the runner is the same process with the same Claude
Code, and nothing restarts. A cold one is a new boot: systemd starts the runner by itself, the
runner reads the session's transcript, starts Claude Code with `--resume` and takes the
message; the agent remembered the board it drew before the sleep every time. Before the fake
API numbered its events from the clock, two cold wakes out of five got no reply: the fake had
come back numbering its feed from an older count, so the new message's id was one the resumed
transcript already held, and the runner, as the protocol says, took it as delivered. That
points at the fake's state file coming back older than it was written before the stop; it was
not confirmed, and the real API never reuses an id. Saving the snapshot took 8.7 s each time;
provisioning a fresh sandbox 22 to 33 s; a whole bake, checks and both sandboxes included,
about 8.5 minutes (the secret scan is most of it: 2 to 5 minutes on a disk boat is still
restoring).

What the end-to-end runs saw, beyond the checks: a first turn on Haiku drew the board, wrote a
started notice, a work line ("Drawing "Hello"") and its reply, went working then idle,
reported usage ($0.002 to $0.006 a turn) and uploaded light and dark previews whose text and
emoji are real glyphs; the repo run cloned as `agent` onto `pz/…`, committed and pushed through
the runner's socket, and GitHub shows the person as author and `ponzu-dev[bot]` as committer.
No secret was found on disk after turns and wakes with the real key in the environment.

