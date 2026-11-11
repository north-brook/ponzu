#!/usr/bin/env bash
# Turns boat.dev's base image into the one every design's sandbox starts from. bake.ts uploads
# this folder with the runner's dist/, the font manifest and pins.env beside it, and runs it
# once, as root, in a fresh sandbox; README.md says what each step is for.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
. "$here/pins.env"

PONZU=/opt/ponzu
BUN="$PONZU/bun/$BUN_VERSION/bun"
AGENT_PATH="$PONZU/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
FONTS="$here/sandbox-fonts.json"
work=$(mktemp -d)
step() { echo "== $* ($SECONDS s)"; }

step "the agent's user"
# Claude Code, its tools and the checkout's git run as `agent`: no sudo, no docker, and no way
# into /home/user, the runner's environment or its token. The runner's user joins its group to
# read and write the checkout.
id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --user-group agent
usermod --append --groups agent user
chmod 0750 /home/agent
install -d -o agent -g agent -m 2775 /home/agent/work

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
claude_hash() { sha256sum "$(readlink -f /usr/local/bin/claude)" | cut -d' ' -f1; }
if [ "$(claude_hash)" != "$CLAUDE_SHA256" ]; then
  npm install --global --no-fund --no-audit --cache "$work/npm" "@anthropic-ai/claude-code@$CLAUDE_VERSION"
  [ "$(claude_hash)" = "$CLAUDE_SHA256" ] || { echo "claude is not $CLAUDE_VERSION's binary" >&2; exit 1; }
fi

step "the runner"
rm -rf "$PONZU/runner"
cp -R "$here/runner" "$PONZU/runner"
(cd "$PONZU/runner" && BUN_INSTALL_CACHE_DIR="$work/cache" "$BUN" install --production --silent)
chown -R root:root "$PONZU/runner"

step "Chrome Headless Shell for playwright-core $PLAYWRIGHT_CORE_VERSION"
PLAYWRIGHT_BROWSERS_PATH="$PONZU/browsers" \
  "$BUN" "$PONZU/runner/node_modules/playwright-core/cli.js" install --only-shell chromium \
  > "$work/playwright.log" 2>&1 || { cat "$work/playwright.log"; exit 1; }
shell=$(echo "$PONZU"/browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell)
[ -x "$shell" ] || { echo "no headless shell at $shell" >&2; exit 1; }

step "fonts"
# Exactly packages/render/sandbox-fonts.json, and no recommended extras: fontconfig would
# prefer some of them over Noto. Droid Sans Fallback, in boat's base, is the one other CJK font.
mapfile -t packages < <(jq -r '.apt[]' "$FONTS")
apt_install() { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }
# The base image's package lists are 200 MB: fetched again, they would all be in the snapshot.
apt_install "${packages[@]}" || { apt-get update -qq && apt_install "${packages[@]}"; }
DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq fonts-droid-fallback >/dev/null
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
# already leaves its token out; `env -u` makes sure of it.
cat > "$PONZU/libexec/as-agent" <<EOF
#!/bin/sh
# Runs a command as the agent's user, with the caller's environment but the runner token.
exec sudo -n -E -u agent -- /usr/bin/env -u PONZU_RUNNER_TOKEN HOME=/home/agent USER=agent \\
  LOGNAME=agent PATH=$AGENT_PATH /bin/sh -c 'umask 002; exec "\$@"' sh "\$@"
EOF
printf '#!/bin/sh\nexec %s/libexec/as-agent /usr/local/bin/claude "$@"\n' "$PONZU" > "$PONZU/libexec/agent-claude"
printf '#!/bin/sh\nexec %s/libexec/as-agent /usr/bin/git "$@"\n' "$PONZU" > "$PONZU/libexec/agent-git"
chmod 0755 "$PONZU"/libexec/*

step "the runner's service"
sed -e "s|{{BUN}}|$BUN|g" -e "s|{{RUNNER_DIR}}|$PONZU/runner|g" \
  "$PONZU/runner/ponzu-runner.service" > /etc/systemd/system/ponzu-runner.service
install -d /etc/systemd/system/ponzu-runner.service.d
cat > /etc/systemd/system/ponzu-runner.service.d/image.conf <<EOF
# What this image adds to the runner's unit: where things are, and the agent's user apart.
[Service]
# The checkout is the agent's: files the runner writes there (exports) are the group's too.
Group=agent
UMask=0002
# Reads what the agent writes (Claude Code keeps its transcripts 0600) and nothing more. The
# agent's side starts through sudo, which drops it.
AmbientCapabilities=CAP_DAC_READ_SEARCH
# git's credential helper asks the runner here (PONZU_GIT_SOCKET), as the group.
RuntimeDirectory=ponzu
RuntimeDirectoryMode=0750
Environment=PONZU_CLAUDE=$PONZU/libexec/agent-claude
Environment=PONZU_GIT=$PONZU/libexec/agent-git
Environment=PONZU_GIT_SOCKET=/run/ponzu/git.sock
Environment=PONZU_WORK_ROOT=/home/agent/work
Environment=CLAUDE_CONFIG_DIR=/home/agent/.claude
Environment=PONZU_CHROMIUM=$shell
EOF
systemctl daemon-reload
systemctl enable ponzu-runner.service

step "what was baked"
jq -n --arg inputs "$INPUTS_HASH" --arg bun "$BUN" --arg chromium "$shell" \
  --arg bunVersion "$BUN_VERSION" --arg claude "$CLAUDE_VERSION" --arg playwright "$PLAYWRIGHT_CORE_VERSION" \
  '{inputs: $inputs, bun: {path: $bun, version: $bunVersion}, claude: {path: "/usr/local/bin/claude", version: $claude},
    playwrightCore: $playwright, chromium: $chromium}' > "$PONZU/image.json"

step "leaving nothing behind"
apt-get clean
rm -rf "$work"
echo "== provisioned in $SECONDS s; /opt/ponzu is $(du -sh "$PONZU" | cut -f1)"
