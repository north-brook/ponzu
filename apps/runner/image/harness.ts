/*
 * What the bake, its checks and the end-to-end run do to a sandbox from this machine, on
 * packages/sandbox's provider: run a command and show its output, send a folder, build what
 * runs inside, and destroy what is left when the run is cut short.
 *
 * Secrets go in a sandbox's environment, never in a command. A command line does not stay in
 * the request: sudo writes it to /var/log/auth.log and the journal, and boat keeps it under
 * /home/user/.ascii/processes, all of which a snapshot saved later would hold. So `sh` refuses
 * a command holding the shape of a key or the value of any secret in this process's
 * environment, and the image's secret scan covers both places.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoatProvider, type SandboxProvider } from "@ponzu/sandbox";

export function provider(): SandboxProvider {
  const apiKey = process.env.BOAT_API_KEY;
  if (!apiKey) throw new Error("Set BOAT_API_KEY (an organization key for boat.dev).");
  return new BoatProvider({ apiKey });
}

/** Key shapes, cut out of anything printed: a sandbox's output is shown as it comes. */
export function redact(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…")
    .replace(/boat_[A-Za-z0-9_-]{8,}/g, "boat_…")
    .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, "gh_…")
    .replace(/pzr_[A-Za-z0-9_-]{8,}/g, "pzr_…")
    .replace(/_token=[A-Za-z0-9._-]+/g, "_token=…");
}

/** A variable whose name says it holds a secret. */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL/i;

/**
 * The values of the secrets in `env`, by name: every variable whose name says it is one, long
 * enough not to turn up by chance. The App's key file is named by a path: its contents count.
 */
export function secretValues(env: NodeJS.ProcessEnv): Map<string, string> {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name)) continue;
    if (name.endsWith("_PATH")) {
      try {
        values.set(name, readFileSync(value, "utf8").trim());
      } catch {}
    } else if (value.length >= 12) values.set(name, value);
  }
  return values;
}

/** The names of the secrets whose shape or value `text` holds. */
export function secretsIn(text: string, secrets: Map<string, string>): string[] {
  const found = [...secrets].filter(([, value]) => text.includes(value)).map(([name]) => name);
  if (redact(text) !== text) found.push("a key's shape");
  return found;
}

/** Each file under `dir` that holds one of `secrets`, with the names it holds. */
export function filesWithSecrets(dir: string, secrets: Map<string, string>): string[] {
  const walk = (at: string): string[] =>
    readdirSync(at).flatMap((name) => {
      const path = join(at, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(dir).flatMap((path) => {
    const text = readFileSync(path, "latin1");
    const names = [...secrets].filter(([, v]) => text.includes(v)).map(([n]) => n);
    return names.length ? [`${path} (${names.join(", ")})`] : [];
  });
}

/* Sandboxes this process made and has not destroyed, for when it is stopped. */
const inFlight = new Map<string, SandboxProvider>();

/** Destroy `id` if this process is interrupted before it does. */
export function track(boat: SandboxProvider, id: string): () => void {
  inFlight.set(id, boat);
  return () => forget(id);
}

export function forget(id: string): void {
  inFlight.delete(id);
}

/** On Ctrl-C or SIGTERM, destroy every tracked sandbox before exiting. */
export function destroyOnSignal(): void {
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.error(`\n${signal}: destroying ${[...inFlight.keys()].join(", ") || "nothing"}`);
      void Promise.allSettled([...inFlight].map(([id, boat]) => boat.destroy(id))).then(() =>
        process.exit(130),
      );
    });
  }
}

export class CommandError extends Error {
  override name = "CommandError";
}

/**
 * Runs a command in the sandbox and returns its stdout. Output is shown as it arrives unless
 * `quiet`; a non-zero exit throws with the end of what it wrote.
 */
export async function sh(
  boat: SandboxProvider,
  id: string,
  command: string,
  opts: { timeoutSeconds?: number; quiet?: boolean } = {},
): Promise<string> {
  refuseSecrets(command);
  let stdout = "";
  let stderr = "";
  for await (const event of boat.execStream(id, command, {
    timeoutSeconds: opts.timeoutSeconds ?? 600,
  })) {
    if (event.type === "exit") {
      if (event.exitCode === 0 && !event.timedOut) return stdout;
      const tail = redact(`${stdout}\n${stderr}`.trim().split("\n").slice(-20).join("\n"));
      throw new CommandError(
        `${command.split("\n")[0]} ${event.timedOut ? "timed out" : `exited ${event.exitCode}`}\n${tail}`,
      );
    }
    if (event.type === "stdout") stdout += event.data;
    else stderr += event.data;
    if (!opts.quiet)
      (event.type === "stdout" ? process.stdout : process.stderr).write(redact(event.data));
  }
  throw new CommandError(`${command} ended without an exit`);
}

/**
 * The same for a command that can run for minutes: boat's output stream for a quiet command
 * breaks after a while, so it runs detached and is asked after. Its stdout comes back whole up
 * to 64 KB, which is what `process` keeps.
 */
export async function shLong(
  boat: SandboxProvider,
  id: string,
  command: string,
  timeoutMs = 15 * 60_000,
): Promise<string> {
  refuseSecrets(command);
  const { pid } = await boat.spawn(id, command);
  const done = await until(
    command.split("\n")[0]!,
    async () => {
      const status = await boat.process(id, pid);
      return status.state === "running" ? null : status;
    },
    timeoutMs,
    2_000,
  );
  if (done.state === "exited" && done.exitCode === 0) return done.stdout;
  throw new CommandError(
    `${command.split("\n")[0]} ${done.state} ${done.exitCode}\n${redact(done.stderr.slice(-2000))}`,
  );
}

/** A command that would leave a secret on the sandbox's disk is a bug here: stop before sending it. */
function refuseSecrets(command: string): void {
  const found = secretsIn(command, secretValues(process.env));
  if (found.length)
    throw new Error(`refusing to send a command holding ${found.join(", ")}: use env instead`);
}

/** Sends a folder to `remote` in the sandbox, which is made if it is missing. */
export async function upload(
  boat: SandboxProvider,
  id: string,
  dir: string,
  remote: string,
): Promise<void> {
  // No macOS metadata: Linux's tar would warn of every file's.
  const tar = spawnSync("tar", ["--no-xattrs", "-czf", "-", "-C", dir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const archive = `/tmp/ponzu-upload-${Date.now().toString(36)}.tgz`;
  await boat.writeFile(id, archive, tar.stdout);
  await sh(boat, id, `mkdir -p ${remote} && tar -xzf ${archive} -C ${remote} && rm ${archive}`, {
    quiet: true,
  });
}

/** Builds `entry` into one file for the sandbox's Bun, beside playwright-core rather than with it. */
export async function bundle(entry: string, outdir: string, name: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    naming: name,
    outdir,
    external: ["playwright-core"],
  });
  if (!built.success) throw new AggregateError(built.logs, `could not build ${entry}`);
}

/** A folder that is gone when `work` is done. */
export async function scratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ponzu-image-"));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Waits for `check` to return something, or throws once `ms` have passed. */
export async function until<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  ms: number,
  everyMs = 250,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    const got = await check().catch((err) => {
      last = err;
      return undefined;
    });
    if (got) return got;
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${what}${last ? ` (last: ${String(last)})` : ""}`);
    await Bun.sleep(everyMs);
  }
}

/** Seconds since `start`, to two places. */
export function since(start: number): number {
  return Math.round((performance.now() - start) / 10) / 100;
}
