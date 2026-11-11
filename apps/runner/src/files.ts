import { spawn } from "node:child_process";
import { type AgentFiles, FileError } from "@ponzu/tools";

/*
 * The files the agent names, read and written as the agent. The canvas tools run in the runner's
 * process, which can read its own token and environment (and in the image, through
 * CAP_DAC_READ_SEARCH, any file). A path the agent hands a tool, or a link it made in the
 * checkout, must reach only what the agent could reach itself, so the read and the write are
 * done by a shell started as the agent (`as-agent`, the image's `sudo -u agent` wrapper).
 */

/** Exit codes the scripts below give for what is not there to read. */
const MISSING = 3;
const NOT_FILE = 4;

const READ = `test -e "$1" || exit ${MISSING}; test -f "$1" || exit ${NOT_FILE}; exec head -c "$2" -- "$1"`;
const WRITE = 'mkdir -p -- "$(dirname -- "$1")" && exec cat > "$1"';

/**
 * `asAgent` runs the command it is given as the agent's user; `env` is the environment to start
 * it with, which must not hold the runner token.
 */
export function agentFiles(asAgent: string, env: NodeJS.ProcessEnv): AgentFiles {
  const run = (script: string, args: string[], input?: Uint8Array) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const child = spawn(asAgent, ["/bin/sh", "-c", script, "sh", ...args], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) return resolve(Buffer.concat(out));
        const said = Buffer.concat(err).toString("utf8").trim().split("\n").at(-1) ?? "";
        const path = args[0]!;
        if (code === MISSING) reject(new FileError("missing", path));
        else if (code === NOT_FILE) reject(new FileError("not_file", path));
        else reject(new FileError("denied", said.replace(/^(head|cat|mkdir|sh): /, "")));
      });
      // A shell that refused the write closes its input early; its exit says why.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  return {
    read: (path, max) => run(READ, [path, String(max)]),
    write: async (path, bytes) => void (await run(WRITE, [path], bytes)),
  };
}
