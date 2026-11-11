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
chromium.json    the headless shell playwright-core pins: its linux64 zip's address and hash
recipe.ts        the pins, the folder provision.sh runs from, the snapshot's name
bake.ts          bake, verify, list and prune
checks.ts        the acceptance checks
trial.ts         a sandbox from the image with the runner's fake API beside the runner
e2e.ts           the runner for real: a turn, wakes, a repo checkout and push
durability.ts    checkpoints for real: sleeps as the API does them, a rollback, two cold wakes
sandbox/         what those run inside a sandbox (the fake API, a screenshot, the tools probe)
current.json     the last snapshot baked and checked: name, inputs, base, dates, size, pins
```

## What is in the image

| | Where | Why |
|---|---|---|
| Bun 1.4.2 | `/opt/ponzu/bun/<version>/bun`, `/opt/ponzu/bin/bun` | The runner's. boat's own Bun 1.3.14 (`/usr/local/bin/bun`) hangs renders in a long-lived process, so it stays where it is and the unit names ours. The zip's SHA-256 is checked. |
| The runner | `/opt/ponzu/runner` | `apps/runner/dist` with `bun install --production` (playwright-core only). Owned by root. |
| Claude Code 2.1.322 | `/usr/local/bin/claude` | The version the Agent SDK pin (0.3.322) speaks to. Its manifest gives the linux-x64 binary's hash; boat's base ships exactly that binary today, so it is kept, and installed from npm when the hash differs. |
| Chrome Headless Shell 156.0.8078.4 | `/opt/ponzu/browsers` | What playwright-core 1.64.1 pins: the zip its installer would fetch, from the same address, checked against the hash in `chromium.json` (`recipe.ts` refuses to bake when playwright-core moves on and the file has not). The runner's `PONZU_CHROMIUM` names it. Not boat's Google Chrome. |
| Fonts | `/usr/share/fonts`, `/usr/local/share/fonts/ponzu` | Exactly `packages/render/sandbox-fonts.json`: its apt packages at the versions it pins, with no recommended extras, and its downloads with their hashes checked. boat's Droid Sans Fallback is removed: it was the one other CJK font, and fallback goes by what is installed. Not `playwright install --with-deps`, whose fonts fontconfig would prefer over Noto. |
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

The snapshot is 487 MiB (510,758,912 bytes: what differs from boat's base); `/opt/ponzu` is
369 MiB of it, most of it the headless shell (about 250 MiB) and Bun (95 MiB); the fonts are
most of the rest. (The bake before, which installed the shell through playwright's CLI, was
500 MiB.)

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
- **The canvas tools reach the agent's files as the agent.** They run in the runner's process,
  which can read its own token. A file the agent names to one (`write_html` and
  `create_artboard` by path, `add_asset`, `export`) is read with `head` and written with `cat`
  in a shell started through `as-agent` (`PONZU_AS_AGENT`, `apps/runner/src/files.ts`). So a
  path, or a link a repo committed to `/run/ascii-secrets/env.sh`, the runner's `/proc` or
  `/home/user`, reaches only what the agent could reach with its own tools. Before this, a link
  in the checkout put the runner token and the Claude key into the design.
- **The runner reads Claude Code's transcripts** through `CAP_DAC_READ_SEARCH` (they are 0600
  `agent`; the runner reads them to resume a session and to see which events it already
  holds). sudo drops the capability for the agent's side. Nothing the runner reads with it
  leaves the process but message ids. The repo's `.mcp.json` is read by the runner too, with
  the capability, and handed to Claude Code as `agent`: a link there reaches a root-only file
  only if that file is JSON with `mcpServers` in it.
- The unit's group is `agent` with `UMask=0002`: the socket's group, and the Scratch folder the
  runner makes is the agent's to write in.
- What `agent` cannot do, and the checks confirm: read `/proc/<runner>/environ`, read boat's
  environment file (`/run/ascii-secrets/env.sh`, 0600 `user`), list `/home/user`, `sudo`, or use
  docker; and the canvas tools, called as the runner's unit runs them on links the agent
  planted, read nothing of env.sh, the runner's environment, `/etc/shadow` or `/home/user`, and
  export nothing into `/home/user`. No process of `agent`'s holds `PONZU_RUNNER_TOKEN`.

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
- **The runner keeps `CAP_DAC_READ_SEARCH`** for the transcripts. Moving those reads to a
  helper that runs as `agent` (the Agent SDK can load a session from a `sessionStore`) would let
  the runner drop it.

## Bake

```sh
bun apps/runner/image/bake.ts                 # BOAT_API_KEY in the environment
```

It builds `apps/runner/dist` from this checkout (with the bundle's smoke test) and creates a
sandbox with no environment. There it reads boat's base first (`BASE_FINGERPRINT` in
`recipe.ts`: the release, every package and its version, the fonts, the Claude Code and Bun it
ships), because boat names no version of its base and the same recipe on another base is
another image. The snapshot's name (`ponzu-runner-<12 hex>`) is a hash of that, the recipe,
the pins, the checks and the dist.

- **Already baked and checked** (a ready snapshot of that name, which `current.json` records as
  having passed from the snapshot): the sandbox is destroyed and nothing else happens.
- **Saved but never checked** (a bake that died between saving and checking): it is checked
  now, from a new sandbox, and deleted if it fails.
- **Otherwise** the folder is staged and scanned on this machine for the value of every secret
  in this process's environment (whatever its shape), uploaded, and `provision.sh` runs (about
  25 s). The image checks run, the snapshot is saved (about 9 s; a save that fails or times out
  is deleted by name, so a late one cannot stay unchecked), the sandbox is destroyed, and the
  checks run again in a new sandbox made from the snapshot. A snapshot that fails there is
  deleted. One that passes is written to `current.json`, with `verifiedAt`, and printed as
  `PONZU_SANDBOX_SNAPSHOT=<name>`.

A bake uses two of boat's starts; one that finds its image already baked uses one. Ctrl-C
destroys the sandboxes in flight, and `sweep` destroys any a killed run left.

```sh
bun apps/runner/image/bake.ts --force         # bake even so
bun apps/runner/image/bake.ts verify [name]   # check a saved snapshot from a new sandbox
bun apps/runner/image/bake.ts list
bun apps/runner/image/bake.ts prune --keep 3  # delete all but the newest three and current
bun apps/runner/image/bake.ts sweep           # destroy sandboxes labelled ponzu=image-*
```

A saved snapshot holds only what differs from boat's base, so when boat changes its base the
sandboxes made from an existing snapshot change with it. `verify` shows whether the image still
passes; a new bake makes a new name.

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
- the unit is enabled and filled in; and, from the snapshot, active with no restarts when
  `/health` first answers through the sandbox's token-gated address, before anything touched it;
- the agent's user cannot read the runner's environment or token (above);
- the canvas tools, run under `systemd-run` with the unit's user, group, capability and
  environment (`sandbox/tool-probe.ts`), refuse links the agent planted to env.sh, the runner's
  `/proc/<pid>/environ`, `/etc/shadow` and `/home/user`, and write no export into `/home/user`;
- nothing secret is on disk: the shapes of an Anthropic key or Claude token, a boat key or
  address token, a GitHub token, a Neon or WorkOS key or a runner token in every file a snapshot
  keeps (text and binary; not boat's Docker store, `/var/run`, which is the `/run` tmpfs that
  holds the environment, nor binaries of boat's base that hold a GitHub-token-shaped string in
  compiled code: three trees of other agents' vendored binaries, and `gh` and VS Code's Copilot
  as boat's lazy-restore store mirrors them), and private keys where anything of ours is
  written (the base's toolchains are full of test keys; the machine's own SSH, snakeoil and
  Sunshine keys are boat's). The exceptions are listed in `checks.ts`, each with its reason.
  The scan covers `/var/log` and `/home/user/.ascii`, where a command line ends up (below).

A secret with no shape to look for (R2's secret key, the vault key, a webhook secret) cannot be
found by the scan. Those never reach a sandbox by construction: the bake sandbox has no
environment, the inputs are scanned for their literal values before upload, and `sh` in
`harness.ts` refuses to send a command that holds one. That matters because **a command line
is kept on the disk**: sudo writes it to `/var/log/auth.log` and the journal, and boat keeps it
in `/home/user/.ascii/processes`, which a snapshot saved later would carry. Secrets go in a
sandbox's `env`, never in a command.

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
| 78 | the environment is wrong, the token was revoked (design deleted or settled), or a newer runner took the lease | stays stopped (`RestartPreventExitStatus=78`). **A warm resume does not bring it back**: it thaws the same boot, units and all. So after every warm resume the API asks `/health` (3 s) and, unless the design was settled or deleted, `exec`s `sudo systemctl start ponzu-runner` (same env) and looks again for 20 s; failing that it resumes with a new `env`, which is always a cold start and boots it (`apps/api/src/sandboxes/quiesce.ts`). |
| anything else, or a crash | | restarted after 3 s, for as long as the sandbox is awake |

`systemctl stop ponzu-runner` sends SIGTERM to the runner alone (`KillMode=mixed`) and kills
what is left after 20 s. A warm stop freezes the machine: the runner kept the same process
across both warm wakes measured, and was not signalled. Whether boat signals anything before a
stop that turns cold could not be read back (the journal of the boot before is not kept), so
the API does not rely on a signal: before every stop it asks the runner to get ready (the state
answer's `sleep`, nudged by `POST /report`), and the runner settles, saves a checkpoint, runs
`sync` and says `quiesced`; the API waits up to 30 s for that, then `exec`s `sync` itself and
stops (docs/cloud.md, "Getting ready to sleep"). The runner stays up, so a warm resume finds it
running.

**How long each start takes**, measured from a Mac in the US against boat's EU hosts, on
`small`. "/health" is the runner answering through its address; "first text" is the first words
of the reply to a message sent as soon as the sandbox answered, which is what a person waits for.
The first set is from `ponzu-runner-cac2ee15017d` (this recipe over the runner before the API's
runner protocol landed); the second from this PR's bakes (`ponzu-runner-001b8c8d24e0` and
`ponzu-runner-75552d8049e5`, the current one).

| Start | /health after the call | First text after the call | Runs |
|---|---|---|---|
| Create from the snapshot, earlier | 3.6, 3.9, 4.4, 4.7, 6.2, 6.2, 6.7, 7.4, 11.6, 11.9 s | not measured: a first turn draws | 10 |
| Create from the snapshot, this PR | 6.6, 7.7, 9.0, 10.0, 12.7, 14.5, 30.8 s | | 7 |
| Warm resume (stopped a minute), earlier | 0.57, 0.57, 0.69, 0.81, 0.99 s | 1.8, 2.0, 2.1, 2.1, 2.3 s | 5 |
| Warm resume, this PR | 0.55, 0.55, 0.56, 0.57, 0.59, 0.63 s | 1.6, 1.9, 1.9, 2.0, 2.0, 2.0 s | 6 |
| Cold resume (stopped 11 minutes), earlier | 4.8, 5.3, 5.4, 5.6, 6.3, 7.4, 7.8 s | 8.0, 8.1, 11.6 s | 7 / 3 |
| Cold resume, this PR | 5.0, 5.7, 11.5, 15.8 s | 7.6, 8.1, 17.6, 24.6 s | 4 |

So plan for a create to take up to half a minute and a cold wake up to a quarter of one, though
most are much quicker. A warm resume thaws the same machine: the runner is the same process with
the same Claude Code, and nothing restarts. A cold one is a new boot: systemd starts the runner
by itself, the runner reads the session's transcript, starts Claude Code with `--resume` and
takes the message; the agent remembered the board it drew before the sleep every time. Saving
the snapshot took 6.7 to 8.7 s; provisioning a fresh sandbox 24 to 33 s; a whole bake, checks
and both sandboxes included, about 9 to 10 minutes (the secret scan is most of it: 1.5 to 2.5
minutes in the bake sandbox, 6 minutes on a disk boat is still restoring).

**What a cold start keeps of the disk.** Measured with files written as the runner, git and
Claude Code write theirs (in place and by rename, flushed and not), and the fake API's state,
which it flushes and checks on every start:

- A file written a moment before the stop and not flushed was lost on the next cold start in
  all three e2e runs here; one flushed (`sync <file>`, or fsync) was kept. So the runner now
  runs `sync` once each turn has settled, and keeps its own state (usage totals) flushed.
- **On the second cold start in a row, two of the three e2e runs here (and two of five cold
  wakes before this PR) came back with the disk as it was at the first cold stop**: everything written in the
  boot between, flushed or not, was gone (the fake API restored 7 of its 9 writes; the probe
  file flushed just before the stop held its old value). The same pattern with nothing but files
  being written (two runs: cold, cold; and warm, warm, cold, cold; 15 files each round, by every
  method) kept everything. What differs in the e2e is a running runner, Claude Code and
  Chromium, and the sandbox's `env` and ports. Not explained; worth raising with boat. Until it
  is, treat a sandbox's disk as able to go back to its previous cold stop: the session's
  transcript (the agent forgets the last exchanges; events the API saw acknowledged are not
  delivered again), unpushed commits, and the usage totals (a turn after it is counted again).
  `e2e.ts scratch` fails when it happens, by design.

What the end-to-end runs saw, beyond the checks: a first turn on Haiku drew the board, wrote a
started notice, a work line ("Drawing "Hello"") and its reply, went working then idle,
reported usage ($0.003 to $0.006 a turn) and uploaded light and dark previews whose text and
emoji are real glyphs (Inter and Noto Color Emoji). The review's attack, run for real (a link in
the checkout to boat's environment file, handed to `create_artboard` by path), got "There is no
file at …" and nothing in the design. The repo run cloned as `agent` onto `pz/…`, committed and
pushed through the runner's socket, and GitHub shows the person as author and `ponzu-dev[bot]`
as committer; the branch was deleted after. No secret was found on disk after three turns and
two warm wakes with the real key in the environment.
