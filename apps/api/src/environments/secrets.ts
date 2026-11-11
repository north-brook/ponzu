import type { SecretLimits } from "@ponzu/db";
import type { Binding } from "../vault/vault.ts";

/*
 * A repo's secrets (docs/cloud.md, "Environments"): what may be one, and how one is sealed.
 * A secret reaches the agent's side of every sandbox of the repo's designs as an environment
 * variable, beside Ponzu's own and the design owner's Claude credential, so a name that would
 * replace or steer those, or change how a program there loads code or checks TLS, is refused:
 * on the way in, and again when a sandbox's environment is made.
 */

/** Capitals, digits and underscores, starting with a letter, as Settings writes them. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
export const MAX_SECRET_NAME = 64;
/** 16 KiB: a private key or a service account's JSON fits. */
export const MAX_SECRET_BYTES = 16 * 1024;

/**
 * What one repo's secrets may hold. They travel to a sandbox in one variable, each value in
 * base64 (`sandboxes/environment.ts`), and a sandbox's environment takes at most 64 KB
 * (boat.dev): 44 KiB of names and values is 60 KB encoded, which leaves room for Ponzu's own.
 */
export const SECRET_LIMITS: SecretLimits = { count: 50, totalBytes: 44 * 1024 };

/**
 * Prefixes a secret's name may not start with: Ponzu's own (`PONZU_RUNNER_TOKEN`, …), Claude
 * Code's and Anthropic's (a second credential, or one that points Claude elsewhere: Claude Code
 * would use `ANTHROPIC_API_KEY` over the owner's plan, or send their token to
 * `ANTHROPIC_BASE_URL`), the sandbox provider's, git's (its credential helper is Ponzu's), and
 * those that load code into a program as it starts: the dynamic loader's, Bun's (`BUN_OPTIONS`
 * is extra flags, `--preload` among them), Node's and npm's, and bash's.
 */
const RESERVED_PREFIXES = [
  "PONZU_",
  "CLAUDE_",
  "ANTHROPIC_",
  "ASCII_",
  "BOAT_",
  "GIT_",
  "LD_",
  "DYLD_",
  "BUN_",
  "NODE_",
  "NPM_CONFIG_",
  "BASH_",
];

/** Names under a reserved prefix that only say how a repo's own code runs or installs. */
const ALLOWED_NAMES = new Set(["NODE_ENV", "NODE_AUTH_TOKEN"]);

/**
 * Names a secret may not have: what the runner's process depends on; what a shell runs or
 * reads as it starts; where git and other tools find their configuration; and what would send
 * traffic, the Claude credential with it, through someone else's proxy or certificate.
 */
const RESERVED_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "IFS",
  "PROMPT_COMMAND",
  "PYTHONSTARTUP",
  "XDG_CONFIG_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

/** Why a name can't be a secret's, or null when it can. */
export function secretNameProblem(name: string): "invalid" | "reserved" | null {
  if (name.length > MAX_SECRET_NAME || !SECRET_NAME.test(name)) return "invalid";
  if (ALLOWED_NAMES.has(name)) return null;
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "reserved";
  }
  return null;
}

/**
 * Why a reserved name is, in words for the person who typed it: the prefix it starts with, or
 * that the sandbox itself depends on the name.
 */
export function reservedReason(name: string): string {
  const prefix = RESERVED_PREFIXES.find((p) => name.startsWith(p));
  return prefix
    ? `Names starting with ${prefix} are kept for Ponzu, Claude and the sandbox's own tools. Use another name.`
    : `${name} is a name the sandbox itself depends on. Use another name.`;
}

/** Where a secret's sealed value lives: its repo and name are its row. */
export function secretBinding(repoId: string, name: string): Binding {
  return { column: "repo_secrets.encrypted_value", row: `${repoId}/${name}` };
}

/** A value's size as an environment holds it. */
export function valueBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
