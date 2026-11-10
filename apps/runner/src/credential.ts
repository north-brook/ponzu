/*
 * git's credential helper for github.com in a design's sandbox: `bun git-credential.js <op>`,
 * with git's request on stdin. It asks the API for a one-hour token for the design's own
 * repository each time git needs one, and keeps nothing (docs/cloud.md, "Credentials").
 * It needs PONZU_API_URL and PONZU_RUNNER_TOKEN, which git passes on from whoever ran it.
 */
import type { GitCredentialRequest, GitCredentialResponse } from "./api/protocol.ts";
import { type Endpoint, request } from "./api/request.ts";
import { VERSION } from "./version.ts";

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
export async function helper(op: string, input: string, endpoint: Endpoint): Promise<string> {
  const ask = parseRequest(input);
  if (op === "get")
    return formatCredential(
      await request<GitCredentialResponse>(endpoint, "POST", "/v1/runner/git-credential", ask),
    );
  // GitHub refused what it was given, so the API should not hand it out again.
  if (op === "erase") await request(endpoint, "POST", "/v1/runner/git-credential/erase", ask);
  return "";
}

if (import.meta.main) {
  const { PONZU_API_URL: baseUrl, PONZU_RUNNER_TOKEN: token } = process.env;
  try {
    if (!baseUrl || !token) throw new Error("PONZU_API_URL and PONZU_RUNNER_TOKEN must be set.");
    const input = await new Response(Bun.stdin.stream()).text();
    const op = process.argv[2] ?? "";
    process.stdout.write(await helper(op, input, { baseUrl, token, client: `runner/${VERSION}` }));
  } catch (err) {
    process.stderr.write(`ponzu credential helper: ${err instanceof Error ? err.message : err}\n`);
  }
}
