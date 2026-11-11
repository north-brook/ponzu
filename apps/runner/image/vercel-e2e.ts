#!/usr/bin/env bun
/**
 * The real runner and real Claude turns in a Vercel Sandbox made from our image, against the
 * runner's fake API in the same sandbox (sandbox/fake-api.ts), driven and timed from here:
 *
 *   bun apps/runner/image/vercel-e2e.ts <image> [label]
 *
 * <image> is a VCR reference by digest (vcr.ts prints it). Needs VERCEL_TEAM_ID,
 * VERCEL_API_PROJECT_ID and ANTHROPIC_API_KEY (the development key: never a person's sign-in),
 * and VERCEL_TOKEN or a signed-in Vercel CLI.
 *
 * One run: create, a turn, then stop and wake twice, a turn after each wake (the second is the
 * "double cold start": the runner and Claude Code were running when it stopped). Along the way:
 * the runner's environment against the agent's user, the public addresses without a bearer,
 * whether an SDK get wakes a stopped sandbox, and a wake during `stopping`. The sandbox and its
 * snapshots are deleted at the end. Every line is kept in .context/vercel/results.jsonl.
 */
import { join } from "node:path";
import type { ThreadItem } from "../src/api/protocol.ts";
import {
  addresses,
  control,
  credentials,
  FAKE_API_PORT,
  health,
  installFakeApi,
  need,
  newStart,
  note,
  now,
  OUT,
  RUNNER_PORT,
  runnerEnv,
  Sandbox,
  type Start,
  secs,
  sh,
  startFakeApi,
  startRunner,
  until,
} from "./vercel.ts";

const [image, label = `r${Date.now().toString(36)}`] = process.argv.slice(2);
if (!image) throw new Error("say the image, by digest");
const creds = credentials();
const name = `ponzu-spike-${label}`;
const start: Start = newStart({ ANTHROPIC_API_KEY: need("ANTHROPIC_API_KEY") });
const PROMPT =
  "Make one small artboard named Hello, 320 by 200, with a single centered heading that reads 'Hello from Ponzu'.";
const logs = (what: string) => join(OUT, label, `${what}.log`);
const ctx = { run: label, name };

interface Rec {
  now: number;
  started: number;
  items: ThreadItem[];
  states: { state: string; at: number }[];
  delivered: string[];
  uploads: { purpose: string; name: string }[];
  doc: { doc: { pages: { artboards: { id: string; name: string }[] }[] }; seq: number };
  usage: { models: unknown[] }[];
  claims: number[];
  quiesced: string[];
}

let sb = null as Sandbox | null;
try {
  await run();
} catch (err) {
  note("run.failed", { ...ctx, error: String(err).slice(0, 2000) });
  if (sb) {
    const tail = await sh(
      sb,
      "tail -c 4000 /vercel/fake-api/state.json >/dev/null 2>&1; ps -eo pid,user,etimes,args | head -40",
      { ok: false },
    ).catch((e) => ({ stdout: String(e) }));
    note("run.failed.ps", { ...ctx, ps: tail.stdout });
  }
  process.exitCode = 1;
} finally {
  if (sb) {
    const t0 = now();
    await sb
      .delete({ deleteOrphanSnapshots: true })
      .catch((e: unknown) => note("delete.failed", { ...ctx, error: String(e) }));
    note("deleted", { ...ctx, ms: secs(now() - t0) });
  }
}

async function run() {
  // Create, as the API does for a design's first message.
  const t0 = now();
  sb = await Sandbox.create({
    ...creds,
    name,
    image,
    resources: { vcpus: 2 },
    ports: [RUNNER_PORT, FAKE_API_PORT],
    timeout: 30 * 60_000,
    persistent: true,
    snapshotExpiration: 24 * 3600_000,
    keepLastSnapshots: { count: 1, deleteEvicted: true },
    tags: { ponzu: "spike", run: label },
  });
  const createMs = now() - t0;
  const first = await sh(sb, "true");
  note("create", {
    ...ctx,
    createMs: secs(createMs),
    firstCommandMs: secs(first.ms),
    toFirstCommand: secs(now() - t0),
    status: sb.status,
    region: sb.region,
    image: sb.image,
  });
  const { runner, api } = addresses(sb);
  note("addresses", {
    ...ctx,
    runnerHost: new URL(runner).host.split(".").slice(1).join("."),
    sameHostShape: new URL(api).host.endsWith(".vercel.run"),
  });

  const t1 = now();
  await installFakeApi(sb);
  note("fake.installed", { ...ctx, ms: secs(now() - t1) });
  await bootAndTurn("create", t0);

  await isolation();
  await publicPorts();

  for (const n of [1, 2]) {
    await sleepLikeTheApi(n);
    await getDoesNotWake(n);
    // SPIKE_IDLE_MS: how long the second sleep lasts, to see a restore after the cache has cooled.
    const idle = n === 2 ? Number(process.env.SPIKE_IDLE_MS ?? 0) : 0;
    if (idle) {
      note("idle", { ...ctx, ms: idle });
      await Bun.sleep(idle);
    }
    const w0 = now();
    sb = await Sandbox.get({ ...creds, name, resume: true });
    const firstCmd = await sh(sb, "cat /proc/sys/kernel/random/boot_id; cat /proc/uptime");
    note("wake.firstCommand", {
      ...ctx,
      wake: n,
      toFirstCommand: secs(now() - w0),
      commandMs: secs(firstCmd.ms),
      status: sb.status,
      uptime: firstCmd.stdout.split("\n")[1],
    });
    await bootAndTurn(`wake${n}`, w0);
  }

  await wakeDuringStopping();
}

/** Starts the fake API and the runner as the API would, sends the message, times the turn. */
async function bootAndTurn(phase: string, t0: number) {
  const box = sb!;
  const { runner, api } = addresses(box);
  await startFakeApi(box, start, logs(`${phase}-fake-api`));
  await until(
    "the fake API",
    () => control(api, start, "GET", "record").then(() => true),
    60_000,
    100,
  );
  const fakeUp = now();
  const before = await control<Rec>(api, start, "GET", "record");
  // The message that woke it is in the feed as the runner starts, as the API's wake has it.
  const asked = await control<{ id: string }>(api, start, "POST", "events", {
    kind: "message",
    payload: {
      text:
        phase === "create"
          ? PROMPT
          : `${PROMPT} (Again: replace the existing Hello artboard's heading with 'Hello again ${phase}'.)`,
    },
  });
  const sent = now();
  const { startMs } = await startRunner(
    box,
    runnerEnv(start, `http://127.0.0.1:${FAKE_API_PORT}`),
    logs(`${phase}-runner`),
  );
  const marks: Record<string, number> = {};
  const at = (k: string) => {
    if (!(k in marks)) marks[k] = secs(now() - t0);
  };
  const artboardsBefore = before.doc.doc.pages.flatMap((p) => p.artboards).length;
  const done = await until(
    `the ${phase} turn`,
    async () => {
      if (!("health" in marks) && (await health(runner, start.portToken).catch(() => null)))
        at("health");
      const r = await control<Rec>(api, start, "GET", "record");
      const fresh = r.items.filter((i) => Date.parse(i.at) > before.now);
      if (
        fresh.some(
          (i) =>
            i.kind === "notice" &&
            ["started", "resumed"].includes((i.payload as { type: string }).type),
        )
      )
        at("claudeNotice");
      if (r.claims.some((c) => c > before.now)) at("firstClaim");
      if (r.delivered.includes(asked.id)) at("delivered");
      if (fresh.some((i) => i.kind === "assistant" || i.kind === "tool")) at("firstItem");
      const boards = r.doc.doc.pages.flatMap((p) => p.artboards);
      if (boards.length > artboardsBefore || (phase !== "create" && r.doc.seq > before.doc.seq))
        at("firstArtboard");
      if (r.uploads.length > before.uploads.length) at("firstPreview");
      const states = r.states.filter((s) => s.at > before.now).map((s) => s.state);
      const finished =
        r.delivered.includes(asked.id) &&
        states.includes("working") &&
        states.at(-1) === "idle" &&
        fresh.some((i) => i.kind === "assistant") &&
        !fresh.some((i) => i.streaming);
      return finished ? r : null;
    },
    6 * 60_000,
    150,
  );
  at("turnDone");
  // The light and dark previews come once the edits have been still a moment: Chromium's start.
  const withPreviews = await until(
    "the previews",
    async () => {
      const r = await control<Rec>(api, start, "GET", "record");
      if (r.uploads.length > before.uploads.length) at("firstPreview");
      return r.uploads.length >= before.uploads.length + 2 ? r : null;
    },
    60_000,
    150,
  ).catch(() => null);
  if (withPreviews) at("bothPreviews");
  const boards = done.doc.doc.pages.flatMap((p) => p.artboards.map((a) => a.name));
  const fresh = done.items.filter((i) => Date.parse(i.at) > before.now);
  note("turn", {
    ...ctx,
    phase,
    fromStartSeconds: marks,
    messageToFirstItem:
      marks.firstItem !== undefined
        ? Math.round((marks.firstItem - secs(sent - t0)) * 1000) / 1000
        : null,
    messageToFirstArtboard:
      marks.firstArtboard !== undefined
        ? Math.round((marks.firstArtboard - secs(sent - t0)) * 1000) / 1000
        : null,
    fakeUpAt: secs(fakeUp - t0),
    runnerStartCommandMs: secs(startMs),
    artboards: boards,
    previews: (withPreviews ?? done).uploads.map((u) => u.name),
    tools: fresh
      .filter((i) => i.kind === "tool")
      .map((i) => (i.payload as { label: string }).label),
    reply: fresh
      .filter((i) => i.kind === "assistant")
      .map((i) => (i.payload as { text: string }).text)
      .join(" ")
      .slice(0, 300),
    usage: done.usage.length,
  });
}

/** The runner's environment holds the tokens and the Claude key: the agent's user must not read it. */
async function isolation() {
  const box = sb!;
  // The values to look for go in the command's env, never its text.
  const probe = await sh(
    box,
    `set -u
# The values are looked for with grep -f on a builtin's output, so no process's argv holds them.
vals() { printf '%s\\n' "$PROBE_TOKEN" "$PROBE_PORT" "$PROBE_KEY"; }
tokens() { printf '%s\\n' "$PROBE_TOKEN" "$PROBE_PORT"; }
sup=$(pgrep -f 'runner/supervise.js' | head -1); run=$(pgrep -u ponzu -f 'runner/runner.js' | head -1)
echo "supervisor=$sup user=$(ps -o user= -p $sup) runner=$run user=$(ps -o user= -p $run) init=1 user=$(ps -o user= -p 1)"
for p in 1 $sup $run; do
  if sudo -n -u agent cat /proc/$p/environ >/dev/null 2>&1; then echo "agent READ environ of $p"; else echo "agent cannot read environ of $p"; fi
  echo "root: environ of $p holds a probe value: $(sudo cat /proc/$p/environ | tr '\\0' '\\n' | grep -c -F -f <(vals))"
  echo "agent: cmdline of $p holds a probe value: $(sudo -n -u agent cat /proc/$p/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -c -F -f <(vals))"
done
n=0; for p in $(pgrep -u agent); do c=$(sudo -n -u agent cat /proc/$p/environ 2>/dev/null | tr '\\0' '\\n' | grep -c -F -f <(tokens)); [ "$c" != 0 ] && n=$((n+1)); done
echo "agent processes: $(pgrep -u agent | wc -l); holding a runner or port token: $n"
echo "ps -eo args as agent holds a probe value: $(sudo -n -u agent ps -eo args | grep -c -F -f <(vals))"
echo "sudo as agent: $(sudo -n -u agent sudo -n true 2>&1 | head -1)"
echo "files holding a probe value: $(sudo grep -rlsF -f <(vals) /vercel /home /tmp /var/log /etc /opt /root /run /var/tmp 2>/dev/null | head -5 | tr '\\n' ' ')"
echo "== Vercel's own control surface, from the agent"
ls -la /run/vercel /run/vercel/share 2>&1 | head -12
sudo -n -u agent ls -la /run/vercel/share 2>&1 | head -3
sudo -n -u agent bash -c 'exec 3<>/dev/null; python3 -c 1 2>/dev/null; (echo > /dev/tcp/127.0.0.1/1) 2>/dev/null; if command -v socat >/dev/null; then echo socat; fi; [ -w /run/vercel/share/init.sock ] && echo "init.sock WRITABLE by agent" || echo "init.sock not writable by agent"'
ls -la /run/ponzu 2>&1 | head -3`,
    {
      env: {
        PROBE_TOKEN: start.runnerToken,
        PROBE_PORT: start.portToken,
        PROBE_KEY: start.credential.ANTHROPIC_API_KEY!,
      },
      ok: false,
    },
  );
  note("isolation", { ...ctx, out: probe.stdout, err: probe.stderr.slice(0, 500) });
}

/** The public addresses answer anyone with the URL: the runner's bearer is what stands in the way. */
async function publicPorts() {
  const { runner, api } = addresses(sb!);
  const bare = await fetch(`${runner}/health`, { redirect: "manual" });
  const poke = await fetch(`${runner}/poke`, { method: "POST", redirect: "manual" });
  const control_ = await fetch(`${api}/control/record`, { redirect: "manual" });
  const withBearer = await fetch(`${runner}/health`, {
    headers: { authorization: `Bearer ${start.portToken}` },
  });
  note("publicPorts", {
    ...ctx,
    healthNoBearer: bare.status,
    pokeNoBearer: poke.status,
    fakeControlNoBearer: control_.status,
    healthWithBearer: withBearer.status,
    server: bare.headers.get("server"),
  });
}

/** As the API's idle stop: ask for a report with sleep set, wait for ready, sync, stop. */
async function sleepLikeTheApi(n: number) {
  const box = sb!;
  const { api } = addresses(box);
  const sleep = new Date().toISOString();
  const q0 = now();
  await control(api, start, "PUT", "sleep", { sleep });
  const quiesced = await until(
    "ready for sleep",
    async () => (await control<Rec>(api, start, "GET", "record")).quiesced.includes(sleep),
    30_000,
    200,
  ).catch(() => false);
  const quiesceMs = now() - q0;
  const s0 = now();
  await sh(box, "sync", { sudo: true });
  const syncMs = now() - s0;
  const t0 = now();
  const stopped = await box.stop();
  const stopMs = now() - t0;
  // stop() can resolve before the stop is over (vercel/sandbox#350): see what get says.
  const after = await Sandbox.get({ ...creds, name, resume: false });
  note("stop", {
    ...ctx,
    n,
    quiesced: Boolean(quiesced),
    quiesceMs: secs(quiesceMs),
    syncMs: secs(syncMs),
    stopMs: secs(stopMs),
    statusAfterStop: after.status,
    snapshotId: stopped.snapshot?.id ?? after.currentSnapshotId ?? null,
    snapshotBytes: stopped.snapshot?.sizeBytes ?? null,
    snapshotMiB: stopped.snapshot?.sizeBytes
      ? Math.round(stopped.snapshot.sizeBytes / 1048576)
      : null,
  });
}

/** Whether an SDK get (resume false) wakes a stopped sandbox, or reading its fields does. */
async function getDoesNotWake(n: number) {
  const a = await Sandbox.get({ ...creds, name, resume: false });
  const fields = {
    status: a.status,
    routes: a.routes.length,
    snapshot: a.currentSnapshotId ?? null,
  };
  await Bun.sleep(5_000);
  const b = await Sandbox.get({ ...creds, name, resume: false });
  const page = await Sandbox.list({ ...creds, tags: { run: label } });
  const listed = page.sandboxes.map((s) => `${s.name}:${s.status}`);
  note("getDoesNotWake", { ...ctx, n, first: fields, after5s: b.status, listed });
}

/** stop() not awaited, then a resume as soon as the stop is under way. */
async function wakeDuringStopping() {
  const box = sb!;
  await sh(box, "true");
  const t0 = now();
  const stopping = box.stop().then(
    (r) => ({ ok: true, ms: secs(now() - t0), status: r.status }),
    (e) => ({ ok: false, ms: secs(now() - t0), error: String(e).slice(0, 300) }),
  );
  let seen = "";
  for (let i = 0; i < 40; i++) {
    const s = await Sandbox.get({ ...creds, name, resume: false });
    seen = s.status;
    if (seen === "stopping" || seen === "snapshotting") break;
    await Bun.sleep(100);
  }
  const w0 = now();
  const woke = await Sandbox.get({ ...creds, name, resume: true }).then(
    async (s) => {
      const r = await sh(s, "cat /proc/uptime");
      return { ok: true, ms: secs(now() - w0), status: s.status, uptime: r.stdout.trim() };
    },
    (e) => ({ ok: false, ms: secs(now() - w0), error: String(e).slice(0, 300) }),
  );
  note("wakeDuringStopping", { ...ctx, statusWhenWoken: seen, wake: woke, stop: await stopping });
  const final = await Sandbox.get({ ...creds, name, resume: false });
  note("wakeDuringStopping.after", { ...ctx, status: final.status });
  sb = final;
}
