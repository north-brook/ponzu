# The sandbox image

Every canvas's Vercel Sandbox starts from one container image: Ubuntu 24.04 (by digest) with
what the runner needs of a machine. It is pushed to the **ponzu-api** project's Vercel Container
Registry as `ponzu-runner` and named by digest in `current.json`, which the API imports
(`@ponzu/runner/image/current.json`) and so ships with every API deploy. A VCR repository belongs
to one project, so the short `ponzu-runner@sha256:…` resolves for the API's OIDC and for the
token triple scoped to that project.

The image holds **no runner**. At every start of a sandbox the API runs `ponzu-start` with the
runner's environment; it fetches the runner bundle the API names (`GET /v1/runner/bundle`, the
tgz `apps/runner/scripts/build.ts` makes), checks its SHA-256 and that it fits the image, and
starts its supervisor. A runner change ships with the API alone; only an OS, font, Bun, Claude
Code or headless-shell change makes a new image, and every canvas is then recreated at its next
wake (the runner rebuilds from git and R2; gitignored files are lost).

```
Dockerfile       FROM ubuntu:24.04@sha256:…, provision.sh once, USER ubuntu, PATH with /opt/ponzu/bin
provision.sh     the recipe, run once as root in the build
pins.json        the one pin source: Bun, Claude Code, playwright-core, the headless shell
libexec/         ponzu-start, ponzu-stop, bundle-fits, installed as they are
image.ts         the inputs, their hash (the tag), current.json's shape
build.ts         build, push, wait for Ready, check, record current.json
checks.ts        the acceptance checks, in a pz-test-image-* sandbox
e2e.ts           the runner for real: turns, sleeps and wakes, a repo checkout and push
durability.ts    a sleep and a wake, then the sandbox removed and the canvas rebuilt
bump.ts          moves the Agent SDK and Claude Code pins together, for claude-code.yml
live.ts          what those three do to a sandbox, on @ponzu/sandbox only
sandbox/         what they run inside a sandbox: the fake API, a screenshot, the tools probe
current.json     the image the API runs: digest, inputs, base, dates, size, pins
```

## What is in the image

| | Where | Why |
|---|---|---|
| Bun | `/opt/ponzu/bun/<version>/bun`, `/opt/ponzu/bin/bun` | The runner's and the supervisor's. The repo's `packageManager`; the zip's SHA-256 is checked. |
| Claude Code | `/opt/ponzu/claude/<version>/claude`, `/opt/ponzu/bin/claude` | The version the Agent SDK speaks to; its manifest gives the linux-x64 binary's hash. `agent-claude` runs it by path; the sign-in driver runs `/opt/ponzu/bin/claude`. |
| playwright-core | `/opt/ponzu/node_modules` | The one module the runner bundle leaves out; `runner.js` in `/opt/ponzu/runners/<sha256>/` finds it by walking up. |
| Chrome Headless Shell | `/opt/ponzu/browsers` | What that playwright-core pins, from where its installer would fetch it, by hash. `runner.json`'s `PONZU_CHROMIUM` names it. |
| Fonts | `/usr/share/fonts`, `/usr/local/share/fonts/ponzu` | Exactly `packages/render/sandbox-fonts.json`, at the versions it pins, no recommended extras. |
| tmux | apt | The Claude sign-in driver's terminal. |
| `ponzu-start`, `ponzu-stop` | `/opt/ponzu/bin` | The API's two image commands (`IMAGE_COMMANDS`), root via `runCommand({ sudo: true })`. |
| `bundle-fits` | `/opt/ponzu/libexec` | Holds a bundle's `manifest.json` `requires` to `image.json`. |
| `runner.json` | `/opt/ponzu` | Where things are, for the supervisor: Bun, users, the runtime dir, the runner's non-secret env. |
| `image.json` | `/opt/ponzu` | `{ claude, playwrightCore }`: what this image installed. |
| The runner's log | `/var/log/ponzu/runner.log` (dir 0750, file 0640 `root:ponzu`) | `ponzu-start` sends the supervisor and runner there, so Vercel's command log holds only the script's own lines. |
| Bundles | `/opt/ponzu/runners/<sha256>/` | Fetched at a start, the newest three kept. |

`ponzu-start` (root, detached, every start): refuses a `PONZU_RUNNER_BUNDLE` that is not hex,
fetches the bundle with the runner token on curl's stdin (never an argv) when the disk lacks it,
exits 78 on a wrong hash or a bundle that does not fit, and runs
`flock -n /run/ponzu-supervisor.lock bun supervise.js`, so a retried start cannot run two.
`ponzu-stop` (root, waited, before every stop): SIGTERM the supervisor, wait up to 25 s for its
lock (the supervisor gives the runner 20 s), `sync`. Idempotent.

## Users

- `ubuntu`: Vercel's commands, with sudo. `Defaults:ubuntu always_set_home, !env_reset` is
  required: without it sudo drops a `sudo: true` command's env and the runner starts without its
  environment.
- `ponzu`: the runner (via `setpriv`, group `agent`, `CAP_DAC_READ_SEARCH` to read Claude Code's
  0600 transcripts). Its only sudo is to become `agent`.
- `agent`: Claude Code, its tools and the checkout's git. No sudo, and no way into `/home/ponzu`,
  `/var/log/ponzu` or the supervisor's and runner's environ. `as-agent` unsets
  `PONZU_RUNNER_TOKEN` and `PONZU_PORT_TOKEN` whatever the caller passed. The canvas tools read
  and write files the agent names through `as-agent`, so a link a repo commits reaches only what
  the agent could reach.

Secrets live only in the one detached start command's `env`: not in the image, not at create,
not on disk. Still open: the Claude credential and the repo's secrets are in the agent's
environment by design (Claude Code and its tools need them), and egress is open.

## Build

```sh
vercel vcr login docker --project <ponzu-api> --scope <team>      # 12 hours
VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… bun apps/runner/image/build.ts [--force]
```

The inputs are the Dockerfile, provision.sh, pins.json, the font manifest and libexec/; their
hash's first 12 characters are the tag. A tag VCR already has is not built again, and one
current.json already records as checked is left alone. Otherwise: `docker buildx build
--platform linux/amd64 --provenance=false`, pushed with zstd layers; `vercel vcr image ls` until
VCR says Ready; `checks.ts` in a sandbox from the digest; then `current.json`. The staged
context is scanned for any secret value of the environment before the build.

`.github/workflows/image.yml` does the same on `ubuntu-latest` (amd64, so no emulation) for
pushes touching the inputs, logs docker in with `vercel/vcr-action/login` (GitHub OIDC; needs a
VCR OIDC policy for this repository) and uses the `VERCEL_TOKEN` secret with the
`VERCEL_TEAM_ID` and `VERCEL_API_PROJECT_ID` variables for the rest, then opens a pull request
with `current.json` and dispatches CI on it. Without that setup it passes with a warning naming
what is missing (docs/cloud.md, "Setting up the image workflows").

## Claude Code and the Agent SDK (bump.ts)

`.github/workflows/claude-code.yml` moves the two pins together when a newer Agent SDK is out,
builds and checks the image through `image.yml`, runs `e2e.ts scratch`, and opens or updates one
pull request saying what passed (docs/cloud.md, "Keeping Claude Code current"). By hand:

```sh
bun apps/runner/image/bump.ts discover                          # what would move
bun apps/runner/image/bump.ts apply --dry-run --pretend 0.3.321 # the whole change path, written nowhere
bun apps/runner/image/bump.ts apply                             # pins.json, package.json, bun.lock
```

`apply` verifies the release's `manifest.json` with Anthropic's release key (fingerprint
`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`, as code.claude.com/docs/en/setup gives it; needs
`gpg`), streams the binary through SHA-256 and holds it to that manifest's hash and size, and
after `bun add` to the SDK package's own manifest. It refuses an SDK whose Claude Code has
another patch number. `bump.test.ts` runs its pure parts on answers recorded in
`fixtures/bump/`.

`image.test.ts` fails when current.json is stale for the inputs, when its pins are not
pins.json's, when the runner bundle's `requires` are not pins.json's Claude Code and
playwright-core, or when pins.json disagrees with what pins each version (the repo's
`packageManager`, the Agent SDK's manifest, playwright-core's browsers.json).

## The checks (checks.ts)

In one persistent `pz-test-image-*` sandbox, removed at the end:

1. versions and hashes are the pinned ones; `claude` is on PATH; tmux is there;
2. packages/render's stand-ins font test passes with no skips;
3. Chromium takes a screenshot with its sandbox on;
4. the Claude sign-in driver's `start` reaches its login URL;
5. `ponzu-start` with a wrong bundle hash exits 78 and leaves nothing;
6. `ponzu-start` fetches the bundle from the fake API and the runner answers `/health` with the
   port's bearer, 401 without it, with a wrong one and on `/poke`;
7. a turn through the fake API (a real Haiku turn with `ANTHROPIC_API_KEY`, else a claim only);
8. the agent cannot read the supervisor's or runner's environ, `/home/ponzu` or
   `/var/log/ponzu`, nor sudo, and none of its processes holds a token;
9. the canvas tools, run as the supervisor runs the runner, refuse links to the runner's log,
   its environ, `/etc/shadow` and `/home/ponzu`, and exports into `/home/ponzu`;
10. after a stop (ponzu-stop, then stop) and a resume, no value of the start's tokens or key and
    no key shape is on the disk.

## Live runs

All need the Vercel triple; e2e.ts and durability.ts also `ANTHROPIC_API_KEY` (the development
key; the fake API asks for Haiku at low effort) and the GitHub App with `GITHUB_TEST_REPO`. Every sandbox is a `pz-test-*` name and
is removed, on Ctrl-C too; each run ends by listing what is left. Lines are kept in
`.context/image/*.jsonl` (gitignored).

```sh
bun apps/runner/image/checks.ts [image]
bun apps/runner/image/e2e.ts [scratch|repo|all] [image]
bun apps/runner/image/durability.ts [image]
```
