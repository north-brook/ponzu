#!/usr/bin/env bash
# Turns ubuntu:24.04 into the image every design's sandbox starts from. The Dockerfile beside it
# runs it once, as root, in the build, from a folder with the runner's dist/, the font manifest
# and pins.env (recipe.ts stages it); README.md says what each step is for.
#
# Vercel Sandbox boots the image's filesystem and runs nothing of it (no ENTRYPOINT, no CMD, no
# systemd): the API starts the runner's supervisor with a command at every start of the sandbox
# (supervise.ts), and the commands the API runs are the image's USER's (`ubuntu`, with sudo).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
. "$here/pins.env"

PONZU=/opt/ponzu
BUN="$PONZU/bun/$BUN_VERSION/bun"
CLAUDE="$PONZU/claude/$CLAUDE_VERSION/claude"
AGENT_PATH="$PONZU/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
FONTS="$here/sandbox-fonts.json"
work=$(mktemp -d)
step() { echo "== $* ($SECONDS s)"; }
export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }

step "packages"
apt-get update -qq
# What the recipe and the runner use, sudo for the API's user, git for checkouts, and the
# libraries Chrome Headless Shell links against (it ships none of them).
apt_install ca-certificates curl jq unzip sudo git procps util-linux \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libasound2t64 libdbus-1-3 libdrm2 libexpat1 libglib2.0-0t64 libx11-6 libxcb1 libxext6

step "the three users"
# ubuntu: the image's USER, whose commands the API runs (Vercel's own images give it sudo and
#   /vercel, and so does this one).
# ponzu: the runner. No sudo but to become the agent, and no login.
# agent: Claude Code, its tools and the checkout's git. No sudo, and no way into the runner's
#   home, its environment or its tokens. The runner's user joins its group to read and write
#   the checkout.
install -d -o ubuntu -g ubuntu /vercel
usermod --home /vercel ubuntu
id ponzu >/dev/null 2>&1 || useradd --create-home --shell /usr/sbin/nologin --user-group ponzu
id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group agent
usermod --append --groups agent ponzu
chmod 0750 /home/ponzu /home/agent
install -d -o agent -g agent -m 2775 /home/agent/work
cat > /etc/sudoers.d/ponzu <<'EOF'
Defaults !fqdn
# Vercel runs a `sudo: true` command through sudo as ubuntu: without these (which Vercel's own
# base image has), sudo drops the command's env, and the runner starts without its environment.
Defaults:ubuntu always_set_home, !env_reset
ubuntu ALL=(ALL) NOPASSWD:ALL
# The runner starts the agent's side through as-agent, with its environment (-E).
ponzu ALL=(agent) NOPASSWD:SETENV: ALL
EOF
chmod 0440 /etc/sudoers.d/ponzu
visudo -cq

step "Bun $BUN_VERSION"
curl -fsSL --retry 3 -o "$work/bun.zip" \
  "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip"
echo "$BUN_SHA256  $work/bun.zip" | sha256sum --check --quiet
unzip -q "$work/bun.zip" -d "$work"
install -D -m 0755 "$work/bun-linux-x64/bun" "$BUN"
install -d "$PONZU/bin"
ln -sfn "$BUN" "$PONZU/bin/bun"
ln -sfn "$BUN" "$PONZU/bin/bunx"

step "Claude Code $CLAUDE_VERSION"
# The runner's Agent SDK speaks to exactly this version, and its manifest says the binary's hash.
curl -fsSL --retry 3 -o "$work/claude" "$CLAUDE_URL"
echo "$CLAUDE_SHA256  $work/claude" | sha256sum --check --quiet
install -D -m 0755 "$work/claude" "$CLAUDE"
ln -sfn "$CLAUDE" "$PONZU/bin/claude"

step "the runner"
rm -rf "$PONZU/runner"
cp -R "$here/runner" "$PONZU/runner"
(cd "$PONZU/runner" && BUN_INSTALL_CACHE_DIR="$work/cache" "$BUN" install --production --silent)
chown -R root:root "$PONZU/runner"

step "Chrome Headless Shell for playwright-core $PLAYWRIGHT_CORE_VERSION"
curl -fsSL --retry 3 -o "$work/shell.zip" "$CHROMIUM_URL"
echo "$CHROMIUM_SHA256  $work/shell.zip" | sha256sum --check --quiet
browsers="$PONZU/browsers/chromium_headless_shell-$CHROMIUM_REVISION"
rm -rf "$browsers"
install -d "$browsers"
unzip -q "$work/shell.zip" -d "$browsers"
shell="$browsers/chrome-headless-shell-linux64/chrome-headless-shell"
[ -x "$shell" ] || { echo "no headless shell at $shell" >&2; exit 1; }

step "fonts"
# Exactly packages/render/sandbox-fonts.json at the versions it pins (Ubuntu 24.04's), and no
# recommended extras: fontconfig would prefer some of them over Noto.
mapfile -t packages < <(jq -r '.apt[]' "$FONTS")
apt_install --allow-downgrades "${packages[@]}"
fonts=$(jq -r .downloadDir "$FONTS")
install -d -m 0755 "$fonts"
jq -r '.download[] | [.file, .url, .sha256] | @tsv' "$FONTS" | while IFS=$'\t' read -r file url sha; do
  curl -fsSL --retry 3 -o "$fonts/$file" "$url"
  echo "$sha  $fonts/$file" | sha256sum --check --quiet
  chmod 0644 "$fonts/$file"
done
fc-cache -f >/dev/null

step "running as the agent"
install -d "$PONZU/libexec"
# sudo keeps the environment (-E) but for PATH, so PATH and HOME are set here. The runner
# already leaves its tokens out; `env -u` makes sure of it.
cat > "$PONZU/libexec/as-agent" <<EOF
#!/bin/sh
# Runs a command as the agent's user, with the caller's environment but the runner's tokens.
exec sudo -n -E -u agent -- /usr/bin/env -u PONZU_RUNNER_TOKEN -u PONZU_PORT_TOKEN \\
  HOME=/home/agent USER=agent LOGNAME=agent PATH=$AGENT_PATH /bin/sh -c 'umask 002; exec "\$@"' sh "\$@"
EOF
printf '#!/bin/sh\nexec %s/libexec/as-agent %s "$@"\n' "$PONZU" "$CLAUDE" >"$PONZU/libexec/agent-claude"
printf '#!/bin/sh\nexec %s/libexec/as-agent /usr/bin/git "$@"\n' "$PONZU" > "$PONZU/libexec/agent-git"
chmod 0755 "$PONZU"/libexec/*

step "the runner's start"
# What the unit's drop-in was: where things are, for the supervisor to put in the runner's
# environment under what the API's start command brings. No secrets.
jq -n --arg bun "$BUN" --arg runner "$PONZU/runner/runner.js" --arg shell "$shell" --arg p "$PONZU" '{
  bun: $bun, runner: $runner, user: "ponzu", group: "agent", home: "/home/ponzu",
  runtimeDir: "/run/ponzu",
  env: {
    PONZU_AS_AGENT: "\($p)/libexec/as-agent",
    PONZU_CLAUDE: "\($p)/libexec/agent-claude",
    PONZU_GIT: "\($p)/libexec/agent-git",
    PONZU_GIT_SOCKET: "/run/ponzu/git.sock",
    PONZU_WORK_ROOT: "/home/agent/work",
    PONZU_STATE_DIR: "/home/ponzu/.ponzu",
    CLAUDE_CONFIG_DIR: "/home/agent/.claude",
    PONZU_CHROMIUM: $shell,
    PATH: "\($p)/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  }}' > "$PONZU/runner.json"
# The one command the API runs, as root, at every start: one supervisor at a time, whatever
# retries the start command.
cat > "$PONZU/bin/ponzu-start" <<EOF
#!/bin/sh
exec /usr/bin/flock -n /run/ponzu-supervisor.lock $BUN $PONZU/runner/supervise.js
EOF
chmod 0755 "$PONZU/bin/ponzu-start"

step "what was baked"
jq -n --arg inputs "$INPUTS_HASH" --arg bun "$BUN" --arg chromium "$shell" --arg claudePath "$CLAUDE" \
  --arg bunVersion "$BUN_VERSION" --arg claude "$CLAUDE_VERSION" --arg playwright "$PLAYWRIGHT_CORE_VERSION" \
  '{inputs: $inputs, bun: {path: $bun, version: $bunVersion}, claude: {path: $claudePath, version: $claude},
    playwrightCore: $playwright, chromium: $chromium}' > "$PONZU/image.json"

step "leaving nothing behind"
apt-get clean
rm -rf "$work" /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log
echo "== provisioned in $SECONDS s; /opt/ponzu is $(du -sh "$PONZU" | cut -f1)"
