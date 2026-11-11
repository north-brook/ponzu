import { spawn } from "node:child_process";

/**
 * Runs a command on the agent's side and answers what it printed: as the agent's user in the
 * image (`as-agent`), as the runner's own where they are the same. The checkout, the Scratch
 * folder and Claude Code's transcripts are the agent's files, so the runner reads and writes
 * them through this, never with its own privileges.
 */
export type AgentShell = (
  args: string[],
  opts?: { cwd?: string; input?: Uint8Array; env?: Record<string, string> },
) => Promise<Uint8Array>;

export class ShellError extends Error {
  override name = "ShellError";
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/** The most a command may print before it is stopped: an archive, at most. */
const MAX_OUTPUT = 80 * 1024 * 1024;
const TIMEOUT_MS = 2 * 60_000;

/**
 * `asAgent` is the image's wrapper that runs its arguments as the agent's user, or undefined to
 * run them as this process. `env` is what they start with: it must not hold the runner token.
 */
export function agentShell(asAgent: string | undefined, env: NodeJS.ProcessEnv): AgentShell {
  return (args, opts = {}) =>
    new Promise((resolve, reject) => {
      const [command, ...rest] = asAgent ? [asAgent, ...args] : args;
      const child = spawn(command!, rest, {
        cwd: opts.cwd,
        env: { ...env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) child.kill("SIGKILL");
        else out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (err.length < 64) err.push(chunk);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) return resolve(new Uint8Array(Buffer.concat(out)));
        const said = Buffer.concat(err).toString("utf8").trim().split("\n").at(-1) ?? "";
        reject(new ShellError(`${args[0]} exited ${code}${said ? `: ${said}` : ""}`, code));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    });
}

/**
 * A shell script that puts the gzipped tar on its input under the folder `$1`, keeping every file
 * the folder has that is newer than the archive's copy. GNU tar's `--keep-newer-files` fails the
 * whole extraction over a folder that is newer (bsdtar's does not), so the archive goes to a
 * folder of its own beside them and each file is moved over unless the one there is newer; tar
 * keeps the times the files had, and refuses names that climb out with `..`.
 */
export const UNPACK_KEEPING_NEWER = `set -e
mkdir -p "$1"
tmp=$(mktemp -d "$1/.ponzu-restore.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
tar -xzf - -C "$tmp" --no-same-owner
cd "$tmp"
find . \\( -type f -o -type l \\) -print | while IFS= read -r f; do
  to="$1/\${f#./}"
  if [ -e "$to" ] && [ "$to" -nt "$f" ]; then continue; fi
  mkdir -p "$(dirname "$to")"
  mv -f "$f" "$to"
done`;

/** The text a command printed. */
export const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
