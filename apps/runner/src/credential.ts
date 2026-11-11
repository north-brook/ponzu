/*
 * git's credential helper for github.com in a design's sandbox: `bun git-credential.js <socket>
 * <op>`, with git's request on stdin. It asks the runner, over the socket the runner listens on
 * (`serveCredentials` in server.ts), and the runner asks the API for a one-hour token for the
 * design's own repository with its own token and lease (docs/cloud.md, "Git"). So the agent's
 * git, which runs as the agent's user, holds no runner token, and the helper keeps nothing.
 */
import type { ErrorBody, GitCredentialRequest, GitCredentialResponse } from "./api/protocol.ts";

/** git's `key=value` lines. */
export function parseRequest(input: string): GitCredentialRequest {
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return {
    protocol: fields.get("protocol") ?? "",
    host: fields.get("host") ?? "",
    path: fields.get("path") ?? "",
  };
}

/** The lines git reads back. `password_expiry_utc` lets git ≥ 2.40 drop the token when it runs out. */
export function formatCredential(c: GitCredentialResponse): string {
  const expiry = Math.floor(Date.parse(c.expiresAt) / 1000);
  return `username=${c.username}\npassword=${c.password}\npassword_expiry_utc=${expiry}\n`;
}

/** Answers one helper call. Prints nothing when there is no credential: git then fails as it should. */
export async function helper(op: string, input: string, socket: string): Promise<string> {
  // git also says `store`, which keeps nothing here.
  if (op !== "get" && op !== "erase") return "";
  const response = await fetch(`http://runner/${op}`, {
    unix: socket,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parseRequest(input)),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    throw new Error(body?.error.message ?? `The runner answered ${response.status}.`);
  }
  // GitHub refused what it was given, so the API should not hand it out again.
  if (op === "erase") return "";
  return formatCredential((await response.json()) as GitCredentialResponse);
}

if (import.meta.main) {
  try {
    const [socket, op = ""] = process.argv.slice(2);
    if (!socket) throw new Error("Say which socket the runner listens on.");
    const input = await new Response(Bun.stdin.stream()).text();
    process.stdout.write(await helper(op, input, socket));
  } catch (err) {
    process.stderr.write(`ponzu credential helper: ${err instanceof Error ? err.message : err}\n`);
  }
}
