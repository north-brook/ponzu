/*
 * The image's acceptance checks, run in a sandbox. Each one throws when the image is not what
 * the recipe says. `imageChecks` hold in any sandbox the recipe ran in; `bootChecks` need one
 * created from the saved snapshot, with a runner that started by itself and has a session.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SandboxProvider } from "@ponzu/sandbox";
import { bundle, scratch, sh, shLong, upload } from "./harness.ts";
import type { Pins } from "./recipe.ts";
import { health, type Trial } from "./trial.ts";

export interface Check {
  name: string;
  run(): Promise<string>;
}

const CHECKS = "/tmp/ponzu-checks";
const ROOT = join(import.meta.dir, "..", "..", "..");

/** What the recipe installs, what the renderer draws with, and what must not be there. */
export function imageChecks(boat: SandboxProvider, id: string, pins: Pins): Check[] {
  const run = (command: string) => sh(boat, id, command, { quiet: true, timeoutSeconds: 300 });
  return [
    {
      name: "versions are the pinned ones",
      run: async () => {
        const got = JSON.parse(await run(VERSIONS));
        const want = {
          bun: pins.bunVersion,
          unitBun: pins.bunVersion,
          claude: `${pins.claudeVersion} (Claude Code)`,
          claudeSha256: pins.claudeSha256,
          headlessShell: `Google Chrome for Testing ${pins.headlessShellVersion}`,
          playwrightCore: pins.playwrightCoreVersion,
        };
        if (JSON.stringify(got) !== JSON.stringify(want))
          throw new Error(`want ${JSON.stringify(want)}\n got ${JSON.stringify(got)}`);
        return `Bun ${got.bun}, Claude Code ${pins.claudeVersion}, ${got.headlessShell}, playwright-core ${got.playwrightCore}`;
      },
    },
    {
      name: "the stand-in fonts set text as on a Mac (packages/render's stand-ins test)",
      run: async () => {
        await sendChecks(boat, id);
        const out = await run(
          `cd ${CHECKS} && PONZU_CHROMIUM=$(jq -r .chromium /opt/ponzu/image.json) /opt/ponzu/bin/bun test ./stand-ins.test.js 2>&1`,
        );
        // bun test leaves out a count that is zero.
        const count = (what: string) => Number(new RegExp(`(\\d+) ${what}`).exec(out)?.[1] ?? 0);
        const [pass, skip, fail] = [count("pass"), count("skip"), count("fail")];
        // A family the image lacks is skipped, not failed, so a skip is a failure here.
        if (fail !== 0 || skip !== 0 || pass <= 0)
          throw new Error(`${pass} pass, ${skip} skip, ${fail} fail\n${out.slice(-3000)}`);
        return `${pass} pass, 0 skip, 0 fail`;
      },
    },
    {
      name: "Chromium takes a screenshot with its sandbox on",
      run: async () => {
        await sendChecks(boat, id);
        const out = await run(
          `cd ${CHECKS} && PONZU_CHROMIUM=$(jq -r .chromium /opt/ponzu/image.json) /opt/ponzu/bin/bun screenshot.js shot.png`,
        );
        // The script itself fails unless every renderer it saw was sandboxed.
        const shot = JSON.parse(out.trim().split("\n").at(-1)!);
        if (shot.width !== 320 || shot.height !== 160 || shot.bytes < 1000)
          throw new Error(`unexpected screenshot: ${out}`);
        return `${shot.width}×${shot.height} at 2x, ${shot.bytes} bytes; ${shot.sandboxed} of ${shot.renderers} renderers under seccomp in their own PID namespace`;
      },
    },
    {
      name: "the runner's unit is enabled and filled in",
      run: async () => {
        const out = await run(
          "systemctl is-enabled ponzu-runner && systemctl cat ponzu-runner | grep -c '{{' || true",
        );
        const [enabled, placeholders] = out.trim().split("\n");
        if (enabled !== "enabled" || placeholders !== "0")
          throw new Error(`is-enabled: ${enabled}, placeholders left: ${placeholders}`);
        return "enabled, no placeholders left";
      },
    },
    {
      name: "nothing secret is in the image",
      run: async () => {
        // Minutes on a disk still being restored from the snapshot.
        const found = (await shLong(boat, id, SECRETS)).trim();
        if (found) throw new Error(`found:\n${found}`);
        return "no key, token or private key of ours on disk; gh logged out; boat's config holds no token";
      },
    },
  ];
}

/** What only a sandbox made from the snapshot shows: the runner came up by itself, apart. */
export function bootChecks(trial: Trial): Check[] {
  const run = (command: string) => sh(trial.boat, trial.id, command, { quiet: true });
  return [
    {
      name: "the runner came up by itself after boot and /health answers through the address",
      run: async () => {
        // As the unit stood when /health first answered, before the trial restarted it.
        const { boot } = trial;
        const said = await health(trial.runner);
        if (boot.ActiveState !== "active" || boot.NRestarts !== "0" || !said?.ok)
          throw new Error(`at boot: ${JSON.stringify(boot)}, /health now: ${JSON.stringify(said)}`);
        return `active at boot with no restarts; /health ${JSON.stringify(said)}`;
      },
    },
    {
      name: "the canvas tools reach only what the agent's user can",
      run: async () => {
        await sendChecks(trial.boat, trial.id);
        const out = (await run(TOOL_PROBE)).trim().split("\n");
        const probe = JSON.parse(out[0]!);
        const left = Object.fromEntries(out.slice(1).map((l) => l.split("=")));
        const leaks = [
          ...(probe.asAgent ? [] : ["the unit names no PONZU_AS_AGENT"]),
          ...Object.entries(probe.reads as Record<string, { taken: boolean; leaked: boolean }>)
            .filter(([, r]) => r.taken || r.leaked)
            .map(([name]) => `read ${name}`),
          ...(probe.asset.taken || probe.asset.stored ? ["add_asset took env.sh"] : []),
          ...Object.entries(probe.writes as Record<string, { taken: boolean }>)
            .filter(([, w]) => w.taken)
            .map(([name]) => `export ${name}`),
          ...Object.entries(left)
            .filter(([, v]) => v !== "no")
            .map(([k]) => `${k} exists`),
        ];
        if (leaks.length) throw new Error(`${leaks.join(", ")}\n${JSON.stringify(probe)}`);
        return "links to env.sh, the runner's environ, /etc/shadow and /home/user refused; exports into /home/user refused";
      },
    },
    {
      name: "the agent's user cannot read the runner's environment or token",
      run: async () => {
        const out = (await run(ISOLATION)).trim();
        const lines = Object.fromEntries(
          out.split("\n").map((l) => l.split("=") as [string, string]),
        );
        const want = {
          runnerHasToken: "yes",
          agentProcesses: lines.agentProcesses,
          agentEnvHasToken: "no",
          readRunnerEnviron: "denied",
          readEnvFile: "denied",
          listRunnerHome: "denied",
          sudo: "denied",
          docker: "denied",
          groups: "agent",
          socketWritable: "yes",
        };
        if (JSON.stringify(lines) !== JSON.stringify(want) || Number(lines.agentProcesses) < 1)
          throw new Error(`want ${JSON.stringify(want)}\n got ${JSON.stringify(lines)}`);
        return `${lines.agentProcesses} agent processes, none holding the token; /proc, env.sh, /home/user, sudo and docker denied`;
      },
    },
  ];
}

export async function runChecks(checks: Check[]): Promise<{ name: string; result: string }[]> {
  const results: { name: string; result: string }[] = [];
  for (const check of checks) {
    const started = performance.now();
    try {
      const result = await check.run();
      console.log(
        `  ok   ${check.name}: ${result} (${Math.round(performance.now() - started)} ms)`,
      );
      results.push({ name: check.name, result });
    } catch (err) {
      console.log(`  FAIL ${check.name}`);
      throw new Error(`check failed: ${check.name}\n${err instanceof Error ? err.message : err}`);
    }
  }
  return results;
}

/** The fonts test and the screenshot script, built for the sandbox, once per sandbox. */
const sent = new Set<string>();
async function sendChecks(boat: SandboxProvider, id: string): Promise<void> {
  if (sent.has(id)) return;
  await scratch(async (dir) => {
    await bundle(join(ROOT, "packages/render/src/stand-ins.test.ts"), dir, "stand-ins.test.js");
    await bundle(join(import.meta.dir, "sandbox/screenshot.ts"), dir, "screenshot.js");
    await bundle(join(import.meta.dir, "sandbox/tool-probe.ts"), dir, "tool-probe.js");
    mkdirSync(join(dir, "node_modules"));
    await upload(boat, id, dir, CHECKS);
  });
  // playwright-core, as the runner has it.
  await sh(
    boat,
    id,
    `ln -sfn /opt/ponzu/runner/node_modules/playwright-core ${CHECKS}/node_modules/`,
    {
      quiet: true,
    },
  );
  sent.add(id);
}

const VERSIONS = `set -e
image=/opt/ponzu/image.json
bun=$(jq -r .bun.path $image)
# The Bun the runner's unit starts, which must be the same one.
unit_bun=$(systemctl cat ponzu-runner | grep -o '/opt/ponzu/bun/[^/]*/bun' | head -1)
jq -n --arg bun "$($bun --version)" \\
  --arg unitBun "$($unit_bun --version)" \\
  --arg claude "$(/usr/local/bin/claude --version)" \\
  --arg claudeSha256 "$(sha256sum "$(readlink -f /usr/local/bin/claude)" | cut -d' ' -f1)" \\
  --arg headlessShell "$($(jq -r .chromium $image) --version | sed 's/ *$//')" \\
  --arg playwrightCore "$(jq -r .version /opt/ponzu/runner/node_modules/playwright-core/package.json)" \\
  '{bun: $bun, unitBun: $unitBun, claude: $claude, claudeSha256: $claudeSha256, headlessShell: $headlessShell, playwrightCore: $playwrightCore}'`;

/**
 * Files holding the shape of one of Ponzu's secrets, by path and shape, never the match.
 *
 * Tokens (an Anthropic key or Claude token, a boat key or address token, a GitHub token, a Neon
 * or WorkOS key, a runner token), in every file a snapshot keeps, text and binary (the journal
 * is binary), but boat's Docker and containerd stores, `/var/run` (which is `/run`, a tmpfs
 * holding the sandbox's environment, never in a snapshot), and three trees of other agents'
 * vendored binaries in boat's base, where a GitHub-token-shaped string sits in compiled code.
 * boat's lazy-restore store (`/var/lib/ascii-lazy/<kind>/<path>`) mirrors files from all over
 * the disk; a mirror counts where its path would, so those of `/usr` and the like, which hold
 * only the base's own binaries (`gh`, VS Code's Copilot), are left out.
 *
 * Private keys (the GitHub App's), where anything of ours is written: the base image's
 * toolchains are full of test keys. The machine's own are not ours: its SSH host keys (also in
 * cloud-init's root-only instance data), Ubuntu's snakeoil TLS key and the key of boat's
 * desktop streaming server, in /home/user where the agent's user cannot reach.
 *
 * Then the logins boat's base image could carry.
 */
const SECRETS = `bash <<'SCAN'
names=(anthropic boat-key boat-address github neon workos runner)
regexes=(
  'sk-ant-[a-z]{3,5}[0-9]{2}-[A-Za-z0-9_-]{80,}'
  'boat_[A-Za-z0-9]{32,}'
  '_token=[A-Za-z0-9]{40,}'
  'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}'
  'napi_[a-z0-9]{60,}'
  'sk_(test|live)_[A-Za-z0-9]{40,}'
  'pzr_[A-Za-z0-9_-]{20,}'
)
patterns=$(mktemp)
printf '%s\\n' "\${regexes[@]}" > "$patterns"
vendored='^(/var/lib/ascii-lazy/[a-z]+)?(/usr/local/lib/node_modules/@openai/|/opt/ascii-agent/node_modules/@openai/|/root/.prime/agent/kernel-venv/)'
system='^/var/lib/ascii-lazy/[a-z]+/(usr/(bin|sbin|lib|lib32|lib64|libexec|share|include|src|games)|bin|sbin|lib|lib32|lib64|boot|snap)/'
machine='^(/etc/ssh/ssh_host_|/etc/ssl/private/ssl-cert-snakeoil.key$|/home/user/.config/sunshine/sunshine.key$)'
roots="/home /root /opt /etc /srv /usr/local /tmp $(ls -d /var/* | grep -vx -e /var/lib -e /var/run) $(ls -d /var/lib/* | grep -v -e /docker -e /containerd)"
for root in $roots; do
  echo "scanning $root" >&2
  sudo rg -uuu -l --no-messages -f "$patterns" "$root" || true
done | grep -Ev -e "$vendored" -e "$system" | while read -r file; do
  for i in "\${!names[@]}"; do
    sudo rg -q -uuu -e "\${regexes[$i]}" "$file" && echo "$file (\${names[$i]})"
  done
done
sudo rg -uuu -l -U --no-messages -e '-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\\r?\\n[A-Za-z0-9+/=]{40,}' \\
  /home /root/.ssh /opt/ponzu /etc /srv /tmp /var/log /var/tmp 2>/dev/null \\
  | grep -Ev "$machine" | sed 's|$| (private key)|'
gh auth status >/dev/null 2>&1 && echo "gh is logged in"
[ -e /home/user/.config/gh/hosts.yml ] && echo "gh has a hosts.yml"
sudo find /home/user/.config/ascii /home/user/.config/boat -type f -exec grep -il -e token -e secret -e key {} + 2>/dev/null | sed 's|$| (boat config with a credential field)|'
true
SCAN`;

/**
 * As root, for each process: whether the runner's environment holds the token, and whether any
 * of the agent's does. Then as the agent's user: what it must not reach.
 */
const ISOLATION = `runner=$(systemctl show -p MainPID --value ponzu-runner)
sudo grep -qz '^PONZU_RUNNER_TOKEN=' /proc/$runner/environ && echo runnerHasToken=yes || echo runnerHasToken=no
pids=$(pgrep -u agent || true)
echo agentProcesses=$(echo $pids | wc -w)
leak=no; for p in $pids; do sudo grep -qz '^PONZU_RUNNER_TOKEN=' /proc/$p/environ 2>/dev/null && leak=yes; done; echo agentEnvHasToken=$leak
as() { sudo -u agent -- sh -c "$1" >/dev/null 2>&1 && echo allowed || echo denied; }
echo readRunnerEnviron=$(as "cat /proc/$runner/environ")
echo readEnvFile=$(as "cat /run/ascii-secrets/env.sh")
echo listRunnerHome=$(as "ls /home/user")
echo sudo=$(as "sudo -n true")
echo docker=$(as "docker ps")
echo groups=$(sudo -u agent id -Gn)
sudo -u agent test -w /run/ponzu/git.sock && echo socketWritable=yes || echo socketWritable=no`;

/**
 * The confused deputy: the canvas tools run in the runner's process, which can read its own
 * token and, through CAP_DAC_READ_SEARCH, any file. The agent plants the links a hostile repo
 * could commit; sandbox/tool-probe.ts then calls the tools on them as the runner's unit runs
 * (its user, group, capability and environment), and the files an export must not have made are
 * looked for as root.
 */
const TOOL_PROBE = `set -e
runner=$(systemctl show -p MainPID --value ponzu-runner)
d=/home/agent/work/.ponzu-probe
sudo -u agent sh -c "mkdir -p $d && cd $d && ln -sfn /run/ascii-secrets/env.sh env-file.html && ln -sfn /proc/$runner/environ runner-environ.html && ln -sfn /etc/shadow shadow.html && ln -sfn /home/user/.bashrc runner-home.html && ln -sfn /home/user/ponzu-probe-link.png deputy.png"
env=$(systemctl show -p Environment --value ponzu-runner)
sudo systemd-run --wait --pipe --quiet --uid=user --gid=agent \\
  -p AmbientCapabilities=CAP_DAC_READ_SEARCH -p "Environment=$env" \\
  /opt/ponzu/bin/bun ${CHECKS}/tool-probe.js $d
for f in link direct; do sudo test -e /home/user/ponzu-probe-$f.png && echo "$f=yes" || echo "$f=no"; done
sudo rm -rf $d /home/user/ponzu-probe-*.png`;
