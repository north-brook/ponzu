import { spawn } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ToolDef, ToolError, tool } from "@ponzu/tools";
import { z } from "zod";
import { checkSecretName, reservedSecretReason, SECRETS_FOLDER } from "./api/protocol.ts";

/*
 * Secrets the agent asks for in the thread (docs/cloud.md, "Needs you"). The agent calls
 * `request_secret` with a name; the runner raises a `secret` question and waits on it as it does
 * on AskUserQuestion. A person gives the value in their app, which the API seals into the repo's
 * secrets; the runner then fetches it once (`POST /v1/runner/secret`) and writes it as the agent
 * to `~/.ponzu/secrets/<NAME>`, outside the checkout and the transcript, so no checkpoint holds
 * it. Every later start has it in the environment. The value never goes into the thread, the
 * state, a log line, the tool's result or analytics: the runner scrubs it like the start's own.
 */

export const REQUEST_SECRET = "request_secret";

/** Where the file is, as the agent reads the path. */
export const secretPath = (name: string) => `~/${SECRETS_FOLDER}/${name}`;

/** What the agent is told once the value is in the file. */
export function secretSavedText(name: string): string {
  return `${name} is saved to this repository's secrets in Ponzu. It's in the file ${secretPath(name)} now, and in the environment of every command from the sandbox's next start. Never print it.`;
}

/**
 * What the agent is told when the value came after the turn that asked had ended: the file, if
 * it could still be written, and the environment from the next start either way.
 */
export function secretLateText(name: string, written: boolean): string {
  return written
    ? secretSavedText(name)
    : `${name} is saved to this repository's secrets in Ponzu, and in the environment of every command from the sandbox's next start. Never print it.`;
}

/** Puts a secret where the agent can read it, and clears what an earlier start put there. */
export interface SecretWriter {
  write(name: string, value: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Writes as the agent, through the image's `as-agent` wrapper (whose HOME is the agent's): the
 * folder 0700, the file 0600. The value goes on the shell's input, never its arguments.
 */
export function agentSecretWriter(asAgent: string, env: NodeJS.ProcessEnv): SecretWriter {
  const dir = `"$HOME/${SECRETS_FOLDER}"`;
  const run = (script: string, args: string[], input = "") =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(asAgent, ["/bin/sh", "-c", script, "sh", ...args], {
        env,
        stdio: ["pipe", "ignore", "pipe"],
      });
      const err: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(Buffer.concat(err).toString("utf8").trim() || `exit ${code}`)),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  return {
    write: (name, value) =>
      run(
        `umask 077 && mkdir -p ${dir} && chmod 700 "$HOME/.ponzu" ${dir} && cat > ${dir}/"$1" && chmod 600 ${dir}/"$1"`,
        [name],
        value,
      ),
    clear: () => run(`rm -rf ${dir}`, []),
  };
}

/** Writes into `dir` as this process: for a runner outside the image, and for tests. */
export function localSecretWriter(dir: string): SecretWriter {
  return {
    async write(name, value) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, name);
      await writeFile(file, value, { mode: 0o600 });
      await chmod(file, 0o600);
    },
    clear: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * The `request_secret` tool. `ask` raises the question and resolves with the value once a person
 * has given it and the runner has fetched it, or with why not (nobody answered, the API would
 * not show it, the value could not be fetched).
 */
export function requestSecretTool(
  ask: (input: {
    name: string;
    description: string | null;
  }) => Promise<{ value: string } | { refused: string }>,
): ToolDef<any> {
  return tool({
    name: REQUEST_SECRET,
    title: "Ask for a secret",
    group: "converse",
    description:
      "Ask the person for a secret this repository needs (an API key, a token, a password) by its environment variable name. They paste it in Ponzu, which keeps it with the repository's secrets; you never see it in the thread. Once they have, it is in the file ~/.ponzu/secrets/NAME, and in the environment of every command from the sandbox's next start. Read it from there, never print it, and never write it into the repository. Ask only for what you can't go on without, and say in the description what it is for and where to find it.",
    input: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "The environment variable's name: capitals, digits and underscores, like STRIPE_TEST_KEY.",
        ),
      description: z
        .string()
        .max(2_000)
        .optional()
        .describe("What it is for, and where the person can find it, in a sentence or two."),
    },
    handler: async ({ name, description }) => {
      const problem = checkSecretName(name);
      if (problem === "reserved") throw new ToolError(reservedSecretReason(name));
      if (problem) {
        throw new ToolError(
          "A secret's name is capitals, digits and underscores, starting with a letter, at most 64 characters.",
        );
      }
      const got = await ask({ name, description: description?.trim() || null });
      if ("refused" in got) throw new ToolError(got.refused);
      return { text: secretSavedText(name) };
    },
  });
}
