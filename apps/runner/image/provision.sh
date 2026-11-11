#!/usr/bin/env bash
# Turns ubuntu:24.04 into the image every design's sandbox starts from. The Dockerfile beside it
# runs it once, as root, in the build, from a folder holding this script, pins.json, the font
# manifest and libexec/ (build.ts stages it); README.md says what each step is for.
#
# Vercel Sandbox boots the image's filesystem and runs nothing of it (no ENTRYPOINT, no CMD, no
# systemd). The API runs /opt/ponzu/bin/ponzu-start at every start of a sandbox; it fetches the
# runner bundle the API names and starts its supervisor. No runner is in the image: only what the
# runner needs of a machine, and image.json saying which versions those are.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

PONZU=/opt/ponzu
AGENT_PATH="$PONZU/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
FONTS="$here/sandbox-fonts.json"
work=$(mktemp -d)
step() { echo "== $* ($SECONDS s)"; }
export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }

step "packages"
apt-get update -qq
# What this script and the runner use, sudo for Vercel's user, git for checkouts, tmux for the
# Claude sign-in's terminal, and the libraries Chrome Headless Shell links against (it ships
# none of them).
apt_install ca-certificates curl jq unzip sudo git procps util-linux tmux \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libasound2t64 libdbus-1-3 libdrm2 libexpat1 libglib2.0-0t64 libx11-6 libxcb1 libxext6

# The pins, from pins.json: the one place a version or hash is written.
pin() { jq -er ".$1" "$here/pins.json"; }
BUN_VERSION=$(pin bunVersion)
CLAUDE_VERSION=$(pin claudeVersion)
PLAYWRIGHT_CORE_VERSION=$(pin playwrightCoreVersion)
CHROMIUM_REVISION=$(pin headlessShellRevision)
BUN="$PONZU/bun/$BUN_VERSION/bun"
CLAUDE="$PONZU/claude/$CLAUDE_VERSION/claude"

step "the three users"
# ubuntu: the image's USER, whose commands Vercel runs (Vercel's own images give it sudo and
#   /vercel, and so does this one).
# ponzu: the runner. No sudo but to become the agent, and no login.
# agent: Claude Code, its tools and the checkout's git. No sudo, and no way into the runner's
#   home, its environment, its log or its tokens. The runner's user joins its group to read and
#   write the checkout.
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
# The runner's output, which ponzu-start sends here rather than to Vercel's command log. The
# runner's user reads it; the agent's cannot.
install -d -o root -g ponzu -m 0750 /var/log/ponzu
install -o root -g ponzu -m 0640 /dev/null /var/log/ponzu/runner.log

step "Bun $BUN_VERSION"
curl -fsSL --retry 3 -o "$work/bun.zip" \
  "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip"
echo "$(pin bunSha256)  $work/bun.zip" | sha256sum --check --quiet
unzip -q "$work/bun.zip" -d "$work"
install -D -m 0755 "$work/bun-linux-x64/bun" "$BUN"
install -d "$PONZU/bin"
ln -sfn "$BUN" "$PONZU/bin/bun"
ln -sfn "$BUN" "$PONZU/bin/bunx"

step "Claude Code $CLAUDE_VERSION"
# The runner's Agent SDK speaks to exactly this version, and its manifest says the binary's hash.
curl -fsSL --retry 3 -o "$work/claude" "$(pin claudeUrl)"
echo "$(pin claudeSha256)  $work/claude" | sha256sum --check --quiet
install -D -m 0755 "$work/claude" "$CLAUDE"
ln -sfn "$CLAUDE" "$PONZU/bin/claude"

step "playwright-core $PLAYWRIGHT_CORE_VERSION"
# The one module the runner bundle leaves out (it finds its own files at run time). runner.js
# in /opt/ponzu/runners/<sha256>/ finds it here by walking up. --ignore-scripts: it would
# download browsers of its own.
echo '{"private":true}' > "$PONZU/package.json"
(cd "$PONZU" && BUN_INSTALL_CACHE_DIR="$work/cache" "$BUN" add --exact --ignore-scripts --silent \
  "playwright-core@$PLAYWRIGHT_CORE_VERSION")
[ "$(jq -r .version "$PONZU/node_modules/playwright-core/package.json")" = "$PLAYWRIGHT_CORE_VERSION" ]
chown -R root:root "$PONZU/node_modules"
install -d -m 0755 "$PONZU/runners"

step "Chrome Headless Shell for playwright-core $PLAYWRIGHT_CORE_VERSION"
curl -fsSL --retry 3 -o "$work/shell.zip" "$(pin headlessShellUrl)"
echo "$(pin headlessShellSha256)  $work/shell.zip" | sha256sum --check --quiet
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

step "the runner's start and stop"
install -m 0755 "$here/libexec/bundle-fits" "$PONZU/libexec/bundle-fits"
install -m 0755 "$here/libexec/ponzu-start" "$PONZU/bin/ponzu-start"
install -m 0755 "$here/libexec/ponzu-stop" "$PONZU/bin/ponzu-stop"
chmod 0755 "$PONZU"/libexec/*
# What the unit's drop-in was: where things are, for the supervisor to put in the runner's
# environment under what the API's start command brings. No secrets.
jq -n --arg bun "$BUN" --arg shell "$shell" --arg p "$PONZU" --arg path "$AGENT_PATH" '{
  bun: $bun, user: "ponzu", group: "agent", home: "/home/ponzu", runtimeDir: "/run/ponzu",
  env: {
    PONZU_AS_AGENT: "\($p)/libexec/as-agent",
    PONZU_CLAUDE: "\($p)/libexec/agent-claude",
    PONZU_GIT: "\($p)/libexec/agent-git",
    PONZU_GIT_SOCKET: "/run/ponzu/git.sock",
    PONZU_WORK_ROOT: "/home/agent/work",
    PONZU_STATE_DIR: "/home/ponzu/.ponzu",
    CLAUDE_CONFIG_DIR: "/home/agent/.claude",
    PONZU_CHROMIUM: $shell,
    PATH: $path
  }}' > "$PONZU/runner.json"

step "what this image has"
# What bundle-fits holds a runner bundle's manifest to.
jq -n --arg claude "$CLAUDE_VERSION" --arg playwright "$PLAYWRIGHT_CORE_VERSION" \
  '{claude: $claude, playwrightCore: $playwright}' > "$PONZU/image.json"
chmod 0644 "$PONZU/image.json" "$PONZU/runner.json"

step "leaving nothing behind"
apt-get clean
rm -rf "$work" "$PONZU/package.json" "$PONZU/bun.lock" /root/.bun /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log
echo "== provisioned in $SECONDS s; /opt/ponzu is $(du -sh "$PONZU" | cut -f1)"
