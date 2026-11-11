#!/usr/bin/env bun
/**
 * The image's acceptance checks, in one `pz-test-image-*` sandbox made from it, through
 * @ponzu/sandbox as the API uses it:
 *
 *   bun apps/runner/image/checks.ts [image]     current.json's image by default
 *
 * Needs VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID. With ANTHROPIC_API_KEY (the
 * development key, never a person's sign-in) the runner's turn is a real one on Haiku; without
 * it the runner starts Claude Code with a key that is not one and the message is only claimed.
 * build.ts runs these before it records an image in current.json. Each check throws when the
 * image is not what provision.sh says; the sandbox is removed at the end, on Ctrl-C too.
 *
 * The sandbox is persistent (the secret scan runs after a stop and a resume, on the disk the
 * snapshot brought back) and removed with its snapshots at the end.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIGN_IN_DRIVER } from "../../api/src/claude/driver.ts";
import { type Pins, pins as pinned, ROOT, readCurrent } from "./image.ts";
import {
  afterTurn,
  type Box,
  type Bundle,
  buildRunnerBundle,
  bundleEntry,
  health,
  idle,
  installFakeApi,
  mark,
  message,
  newStart,
  RUNNER_PORT,
  record,
  removeBox,
  removeOnSignal,
  reUp,
  type Start,
  sandboxes,
  sh,
  sleepLikeTheApi,
  startEnv,
  startFakeApi,
  startRunner,
  testSpec,
  until,
  upBox,
} from "./live.ts";

export interface Check {
  name: string;
  run(): Promise<string>;
}

const CHECKS = "/tmp/ponzu-checks";
/** What the runner's turn is given when there is no development key: Claude Code starts on it. */
const NOT_A_KEY = "not-a-key";

/** Every check, in order, in a new sandbox from `image`. Answers what each one found. */
export async function runImageChecks(
  image: string,
  opts: { bundle?: Bundle; pins?: Pins } = {},
): Promise<{ name: string; result: string }[]> {
  const pins = opts.pins ?? pinned;
  const bundle = opts.bundle ?? buildRunnerBundle();
  const key = process.env.ANTHROPIC_API_KEY;
  const start = newStart(bundle, key ?? NOT_A_KEY);
  const t0 = performance.now();
  const box = await upBox("image", testSpec(image, { timeoutMs: 30 * 60_000 }));
  console.log(`checking ${image} in ${box.name} (up in ${since(t0)} s)`);
  try {
    return await runChecks(imageChecks(box, start, bundle, pins, Boolean(key)));
  } finally {
    await removeBox(box);
  }
}

function imageChecks(
  box: Box,
  start: Start,
  bundle: Bundle,
  pins: Pins,
  realTurn: boolean,
): Check[] {
  const run = async (script: string, opts: { sudo?: boolean } = {}) =>
    (await sh(box, script, { timeoutMs: 10 * 60_000, ...opts })).stdout;
  return [
    {
      name: "versions and hashes are the pinned ones",
      run: async () => {
        const got = JSON.parse(await run(VERSIONS));
        const want = {
          image: { claude: pins.claudeVersion, playwrightCore: pins.playwrightCoreVersion },
          bun: pins.bunVersion,
          claude: `${pins.claudeVersion} (Claude Code)`,
          claudeSha256: pins.claudeSha256,
          claudeOnPath: "/opt/ponzu/bin/claude",
          headlessShell: `Google Chrome for Testing ${pins.headlessShellVersion}`,
          playwrightCore: pins.playwrightCoreVersion,
          tmux: true,
        };
        if (JSON.stringify(got) !== JSON.stringify(want))
          throw new Error(`want ${JSON.stringify(want)}\n got ${JSON.stringify(got)}`);
        return `Bun ${got.bun}, Claude Code ${pins.claudeVersion} (sha256 ok, on PATH), ${got.headlessShell}, playwright-core ${got.playwrightCore}, tmux`;
      },
    },
    {
      name: "the stand-in fonts set text as on a Mac (packages/render's stand-ins test)",
      run: async () => {
        await sendChecks(box);
        const out = await run(
          `cd ${CHECKS} && PONZU_CHROMIUM=$(jq -r .env.PONZU_CHROMIUM /opt/ponzu/runner.json) /opt/ponzu/bin/bun test ./stand-ins.test.js 2>&1`,
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
        await sendChecks(box);
        const out = await run(
          `cd ${CHECKS} && PONZU_CHROMIUM=$(jq -r .env.PONZU_CHROMIUM /opt/ponzu/runner.json) /opt/ponzu/bin/bun screenshot.js shot.png`,
        );
        // The script itself fails unless every renderer it saw was sandboxed.
        const shot = JSON.parse(out.trim().split("\n").at(-1)!);
        if (shot.width !== 320 || shot.height !== 160 || shot.bytes < 1000)
          throw new Error(`unexpected screenshot: ${out}`);
        return `${shot.width}×${shot.height} at 2x, ${shot.bytes} bytes; ${shot.sandboxed} of ${shot.renderers} renderers under seccomp in their own PID namespace`;
      },
    },
    {
      name: "the Claude sign-in driver's start reaches its login URL",
      run: async () => {
        // As the API's sign-in does: the driver written, then run as Vercel's user, no sudo.
        await sandboxes().writeFile(box.at, "/vercel/ponzu-sign-in.sh", SIGN_IN_DRIVER, {
          mode: 0o700,
        });
        const r = await sh(box, "bash /vercel/ponzu-sign-in.sh start", {
          ok: false,
          timeoutMs: 120_000,
        });
        // The driver prints the URL, or (once the api track moves it) keeps it in a 0600 file.
        const files = await run("cat ~/.st/*.out 2>/dev/null || true");
        await sh(box, "tmux -L st kill-server 2>/dev/null; rm -rf ~/.st /vercel/ponzu-sign-in.sh", {
          ok: false,
        });
        const url = /https:\/\/\S*oauth\/authorize\?\S+/.exec(`${r.stdout}\n${files}`)?.[0];
        if (r.exitCode !== 0 || !url)
          throw new Error(`exit ${r.exitCode}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-500)}`);
        return `URL at ${new URL(url).host}${new URL(url).pathname} (tmux, claude by path)`;
      },
    },
    {
      name: "ponzu-start refuses a bundle whose hash is not the one named (exit 78)",
      run: async () => {
        await installFakeApi(box, bundle);
        await startFakeApi(box, start);
        const wrong = "0".repeat(64);
        const r = await sandboxes().exec(box.at, {
          cmd: "/opt/ponzu/bin/ponzu-start",
          env: startEnv(start, wrong),
          sudo: true,
          timeoutMs: 60_000,
        });
        const left = await run(`ls -A /opt/ponzu/runners`, { sudo: true });
        if (r.exitCode !== 78 || !r.stdout.includes("bundle hash") || left.trim())
          throw new Error(`exit ${r.exitCode}: ${r.stdout} ${r.stderr}; runners/: ${left}`);
        return `exit 78 "bundle hash", nothing left in /opt/ponzu/runners`;
      },
    },
    {
      name: "ponzu-start brings the runner up from the served bundle; /health needs the bearer",
      run: async () => {
        const t0 = performance.now();
        await startRunner(box, start);
        const said = await until("the runner's /health", () => health(box, start), 90_000, 200);
        const healthAfter = since(t0);
        const url = `${box.urls[RUNNER_PORT]}/health`;
        const bare = await fetchStatus(url);
        const wrong = await fetchStatus(url, "Bearer not-the-port-token");
        const poke = await fetchStatus(`${box.urls[RUNNER_PORT]}/poke`, undefined, "POST");
        const where = (await run("ls /opt/ponzu/runners", { sudo: true })).trim();
        const served = (await record(box, start)).bundles;
        if (!said.started || bare !== 401 || wrong !== 401 || poke !== 401)
          throw new Error(
            `health ${JSON.stringify(said)}, bare ${bare}, wrong ${wrong}, poke ${poke}`,
          );
        if (where !== bundle.sha256 || served < 1)
          throw new Error(`runners/: ${where}; bundle served ${served} times`);
        return `/health ${JSON.stringify(said)} ${healthAfter} s after the start; 401 without a bearer, with a wrong one and on /poke; bundle ${bundle.sha256.slice(0, 12)} fetched and unpacked`;
      },
    },
    {
      name: "the runner's turn through the fake API",
      run: async () => {
        const ready = await idle(box, start, "the runner to start Claude Code");
        const from = mark(ready);
        const asked = await message(
          box,
          start,
          realTurn
            ? "Make one small artboard named Check, 320 by 160, with a centered heading that reads 'Image check'. Nothing else."
            : "Hello.",
        );
        if (!realTurn) {
          await until(
            "the message to be claimed",
            async () => (await record(box, start)).delivered.includes(asked.id),
            120_000,
            300,
          );
          return "claimed (no development key: Claude Code ran on a key that is not one)";
        }
        const r = await afterTurn(box, start, asked.id, from, { previews: 2 });
        const boards = r.doc.doc.pages.flatMap((p) => p.artboards.map((a) => a.name));
        const previews = r.uploads.filter((u) => u.purpose === "preview").map((u) => u.name);
        if (!boards.length || !previews.includes("light.png"))
          throw new Error(`artboards ${boards}, previews ${previews}`);
        return `Haiku drew ${boards.join(", ")}; previews ${previews.join(", ")}`;
      },
    },
    {
      name: "the agent's user cannot read the runner's environment, home, log or sudo",
      run: async () => {
        const out = (await run(ISOLATION)).trim();
        const got = Object.fromEntries(
          out.split("\n").map((l) => l.split("=") as [string, string]),
        );
        const want = {
          supervisorUser: "root",
          runnerUser: "ponzu",
          runnerHasToken: "yes",
          agentProcesses: got.agentProcesses,
          agentEnvHasToken: "no",
          readSupervisorEnviron: "denied",
          readRunnerEnviron: "denied",
          listRunnerHome: "denied",
          readRunnerLog: "denied",
          listLogDir: "denied",
          sudo: "denied",
          groups: "agent",
        };
        if (JSON.stringify(got) !== JSON.stringify(want) || Number(got.agentProcesses) < 1)
          throw new Error(`want ${JSON.stringify(want)}\n got ${JSON.stringify(got)}`);
        return `${got.agentProcesses} agent processes, none holding a token; the supervisor's and runner's environ, /home/ponzu, /var/log/ponzu and sudo denied`;
      },
    },
    {
      name: "the canvas tools reach only what the agent's user can (link attacks)",
      run: async () => {
        await sendChecks(box);
        const out = (await run(TOOL_PROBE)).trim().split("\n");
        const probe = JSON.parse(out[0]!);
        const left = Object.fromEntries(out.slice(1).map((l) => l.split("=")));
        const leaks = [
          ...(probe.asAgent ? [] : ["runner.json names no PONZU_AS_AGENT"]),
          ...Object.entries(probe.reads as Record<string, { taken: boolean; leaked: boolean }>)
            .filter(([, r]) => r.taken || r.leaked)
            .map(([name]) => `read ${name}`),
          ...(probe.asset.taken || probe.asset.stored ? ["add_asset took the runner's log"] : []),
          ...Object.entries(probe.writes as Record<string, { taken: boolean }>)
            .filter(([, w]) => w.taken)
            .map(([name]) => `export ${name}`),
          ...Object.entries(left)
            .filter(([, v]) => v !== "no")
            .map(([k]) => `${k} exists`),
        ];
        if (leaks.length) throw new Error(`${leaks.join(", ")}\n${JSON.stringify(probe)}`);
        return "links to the runner's log, its environ, /etc/shadow and /home/ponzu refused; exports into /home/ponzu refused";
      },
    },
    {
      name: "no secret is on the disk after the turn, a stop and a resume",
      run: async () => {
        const slept = await sleepLikeTheApi(box);
        const up = await reUp(box);
        if (up.fresh || up.wasRunning) throw new Error(`the resume was ${JSON.stringify(up)}`);
        const values: Record<string, string> = {
          PROBE_RUNNER_TOKEN: start.runnerToken,
          PROBE_PORT_TOKEN: start.portToken,
          ...(realTurn ? { PROBE_KEY: start.credential.ANTHROPIC_API_KEY } : {}),
        };
        const found = (
          await sh(box, SECRETS, { sudo: true, env: values, timeoutMs: 15 * 60_000 })
        ).stdout.trim();
        if (found) throw new Error(`found:\n${found}`);
        return `ponzu-stop ${slept.ponzuStopMs} s, stop ${slept.stopMs} s (${slept.snapshotMiB} MiB); after the resume no token or key value, and no key shape, under /vercel /home /tmp /var /etc /opt /root /srv /usr/local /run`;
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
      console.log(`  ok   ${check.name}: ${result} (${since(started)} s)`);
      results.push({ name: check.name, result });
    } catch (err) {
      console.log(`  FAIL ${check.name}`);
      throw new Error(`check failed: ${check.name}\n${err instanceof Error ? err.message : err}`);
    }
  }
  return results;
}

/** The fonts test, the screenshot script and the tool probe, built for the sandbox, once. */
const sent = new Set<string>();
async function sendChecks(box: Box): Promise<void> {
  if (sent.has(box.name)) return;
  const dir = mkdtempSync(join(tmpdir(), "ponzu-checks-"));
  try {
    const files = [
      [join(ROOT, "packages/render/src/stand-ins.test.ts"), "stand-ins.test.js"],
      [join(import.meta.dir, "sandbox/screenshot.ts"), "screenshot.js"],
      [join(import.meta.dir, "sandbox/tool-probe.ts"), "tool-probe.js"],
    ] as const;
    await sh(box, `mkdir -p ${CHECKS}/node_modules`);
    for (const [entry, name] of files) {
      await bundleEntry(entry, dir, name);
      await sandboxes().writeFile(
        box.at,
        `${CHECKS}/${name}`,
        new Uint8Array(readFileSync(join(dir, name))),
      );
    }
    // playwright-core, as the runner finds it.
    await sh(box, `ln -sfn /opt/ponzu/node_modules/playwright-core ${CHECKS}/node_modules/`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  sent.add(box.name);
}

async function fetchStatus(url: string, authorization?: string, method = "GET") {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      method,
      redirect: "manual",
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(5_000),
    });
    // The port can answer 502 for a moment right after a start.
    if (r.status !== 502 || attempt >= 10) return r.status;
    await Bun.sleep(150);
  }
}

function since(t0: number): number {
  return Math.round((performance.now() - t0) / 10) / 100;
}

const VERSIONS = `set -e
image=/opt/ponzu/image.json
claude=$(readlink -f /opt/ponzu/bin/claude)
agent_claude=$(grep -o '/opt/ponzu/claude/[^ ]*/claude' /opt/ponzu/libexec/agent-claude)
[ "$agent_claude" = "$claude" ] || { echo "agent-claude runs $agent_claude, not $claude" >&2; exit 1; }
[ "$(jq -r .env.PONZU_CLAUDE /opt/ponzu/runner.json)" = /opt/ponzu/libexec/agent-claude ] \\
  || { echo "runner.json does not name agent-claude" >&2; exit 1; }
[ "$(readlink -f "$(jq -r .bun /opt/ponzu/runner.json)")" = "$(readlink -f /opt/ponzu/bin/bun)" ] \\
  || { echo "runner.json's bun is not /opt/ponzu/bin/bun" >&2; exit 1; }
jq -n --argjson image "$(cat $image)" \\
  --arg bun "$(/opt/ponzu/bin/bun --version)" \\
  --arg claude "$($claude --version)" \\
  --arg claudeSha256 "$(sha256sum "$claude" | cut -d' ' -f1)" \\
  --arg claudeOnPath "$(command -v claude)" \\
  --arg headlessShell "$($(jq -r .env.PONZU_CHROMIUM /opt/ponzu/runner.json) --version | sed 's/ *$//')" \\
  --arg playwrightCore "$(jq -r .version /opt/ponzu/node_modules/playwright-core/package.json)" \\
  --argjson tmux "$(command -v tmux >/dev/null && echo true || echo false)" \\
  '{image: $image, bun: $bun, claude: $claude, claudeSha256: $claudeSha256, claudeOnPath: $claudeOnPath, headlessShell: $headlessShell, playwrightCore: $playwrightCore, tmux: $tmux}'`;

/**
 * As root, which processes are whose and which hold a token; then as the agent's user, what it
 * must not reach.
 */
const ISOLATION = `sup=$(pgrep -f '^/opt/ponzu/bin/bun /opt/ponzu/runners/[^ ]*/supervise.js' | head -1)
run=$(pgrep -u ponzu -f '/runner.js' | head -1)
echo supervisorUser=$(ps -o user= -p "$sup")
echo runnerUser=$(ps -o user= -p "$run")
sudo grep -qz '^PONZU_RUNNER_TOKEN=' /proc/$run/environ && echo runnerHasToken=yes || echo runnerHasToken=no
pids=$(pgrep -u agent || true)
echo agentProcesses=$(echo $pids | wc -w)
leak=no; for p in $pids; do sudo grep -qzE '^PONZU_(RUNNER|PORT)_TOKEN=' /proc/$p/environ 2>/dev/null && leak=yes; done; echo agentEnvHasToken=$leak
as() { sudo -n -u agent -- sh -c "$1" >/dev/null 2>&1 && echo allowed || echo denied; }
echo readSupervisorEnviron=$(as "cat /proc/$sup/environ")
echo readRunnerEnviron=$(as "cat /proc/$run/environ")
echo listRunnerHome=$(as "ls /home/ponzu")
echo readRunnerLog=$(as "cat /var/log/ponzu/runner.log")
echo listLogDir=$(as "ls /var/log/ponzu")
echo sudo=$(as "sudo -n true")
echo groups=$(id -Gn agent)`;

/**
 * The confused deputy: the canvas tools run in the runner's process, which can read its own
 * token and, through CAP_DAC_READ_SEARCH, any file. The agent plants the links a hostile repo
 * could commit; sandbox/tool-probe.ts then calls the tools on them as the supervisor starts the
 * runner (its user, group, capability and runner.json's environment), and the files an export
 * must not have made are looked for as root.
 */
const TOOL_PROBE = `set -e
runner=$(pgrep -u ponzu -f '/runner.js' | head -1)
d=/home/agent/work/.ponzu-probe
sudo -u agent sh -c "mkdir -p $d && cd $d && ln -sfn /var/log/ponzu/runner.log runner-log.html && ln -sfn /proc/$runner/environ runner-environ.html && ln -sfn /etc/shadow shadow.html && ln -sfn /home/ponzu/.bashrc runner-home.html && ln -sfn /home/ponzu/ponzu-probe-link.png deputy.png"
cd /tmp
sudo env -i $(jq -r '.env | to_entries[] | "\\(.key)=\\(.value)"' /opt/ponzu/runner.json) HOME=/home/ponzu \\
  setpriv --reuid=ponzu --regid=agent --init-groups --inh-caps=+dac_read_search --ambient-caps=+dac_read_search \\
  /opt/ponzu/bin/bun ${CHECKS}/tool-probe.js $d
for f in link direct; do sudo test -e /home/ponzu/ponzu-probe-$f.png && echo "$f=yes" || echo "$f=no"; done
sudo rm -rf $d /home/ponzu/ponzu-probe-*.png`;

/**
 * Files holding a secret, by path and kind, never the match: the start's own token and key
 * values (in this command's env, looked for with grep -f on a builtin's output so no argv holds
 * them), then the shapes of Ponzu's secrets, then private keys where anything of ours is
 * written. /proc and /sys are not a disk.
 */
const SECRETS = `bash <<'SCAN'
# Run as root (sudo: true), so grep reads <(vals) itself: an inner sudo would close that fd and
# find nothing. The first line proves the values reach grep.
roots="/vercel /home /tmp /var /etc /opt /root /srv /usr/local /run"
vals() { for v in "\${!PROBE_@}"; do printf '%s\\n' "\${!v}"; done; }
[ "$(printf '%s\\n' "$PROBE_RUNNER_TOKEN" | grep -cF -f <(vals))" = 1 ] || echo "the scan cannot see its values"
grep -rlsF -D skip -f <(vals) $roots 2>/dev/null | sed 's|$| (a value of this start)|'
names=(anthropic github neon workos runner)
regexes=(
  'sk-ant-[a-z]{3,5}[0-9]{2}-[A-Za-z0-9_-]{80,}'
  'gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}'
  'napi_[a-z0-9]{60,}'
  'sk_(test|live)_[A-Za-z0-9]{40,}'
  'pzr_[A-Za-z0-9_-]{20,}'
)
for i in "\${!regexes[@]}"; do
  grep -rlsE -D skip -e "\${regexes[$i]}" $roots 2>/dev/null | sed "s|\\$| (\${names[$i]} shape)|"
done
grep -rlsE -D skip -e '-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----' \\
  /vercel /home /root /etc /opt/ponzu/runners /tmp /var/log /var/tmp 2>/dev/null \\
  | grep -Ev '^(/etc/ssh/ssh_host_|/etc/ssl/private/ssl-cert-snakeoil.key$)' | sed 's|$| (private key)|'
true
SCAN`;

if (import.meta.main) {
  removeOnSignal();
  const image = process.argv[2] ?? readCurrent().image;
  mkdirSync(join(ROOT, ".context", "image"), { recursive: true });
  const results = await runImageChecks(image);
  console.log(`\n${results.length} checks passed on ${image}`);
}
