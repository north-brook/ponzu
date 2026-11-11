/*
 * What the bake, its checks and the end-to-end run do to a sandbox from this machine, on
 * packages/sandbox's provider: run a command and show its output, send a folder, build what
 * runs inside. Nothing here puts a secret in a command: those go in a sandbox's environment.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
  for (;;) {
    const got = await check().catch(() => undefined);
    if (got) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(everyMs);
  }
}

/** Seconds since `start`, to two places. */
export function since(start: number): number {
  return Math.round((performance.now() - start) / 10) / 100;
}
