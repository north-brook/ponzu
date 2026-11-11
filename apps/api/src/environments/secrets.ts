import type { SecretLimits } from "@ponzu/db";
import type { Binding } from "../vault/vault.ts";

/*
 * A repo's secrets (docs/cloud.md, "Environments"): what may be one, and how one is sealed.
 * A secret becomes an environment variable of every sandbox of the repo's designs, beside
 * Ponzu's own and the design owner's Claude credential, so a name that would replace or steer
 * those is refused: on the way in, and again when a sandbox's environment is made.
 */

/** Capitals, digits and underscores, starting with a letter, as Settings writes them. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
export const MAX_SECRET_NAME = 64;
/** 16 KiB: a private key or a service account's JSON fits. */
export const MAX_SECRET_BYTES = 16 * 1024;

/**
 * What one repo's secrets may hold. A sandbox's environment takes at most 100 variables and 64
 * KB (boat.dev), and Ponzu's own take four of those and a few hundred bytes.
 */
export const SECRET_LIMITS: SecretLimits = { count: 50, totalBytes: 48 * 1024 };

/**
 * Prefixes a secret's name may not start with: Ponzu's own (`PONZU_RUNNER_TOKEN`, …), Claude
 * Code's and Anthropic's (a second credential, or one that points Claude elsewhere: Claude Code
 * would use `ANTHROPIC_API_KEY` over the owner's plan, or send their token to
 * `ANTHROPIC_BASE_URL`), the sandbox provider's, git's (its credential helper is Ponzu's), and
 * the loader's.
 */
const RESERVED_PREFIXES = ["PONZU_", "CLAUDE_", "ANTHROPIC_", "ASCII_", "BOAT_", "GIT_", "LD_"];

/**
 * Names a secret may not have: what the runner's process depends on, and what would send its
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
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

/** Why a name can't be a secret's, or null when it can. */
export function secretNameProblem(name: string): "invalid" | "reserved" | null {
  if (name.length > MAX_SECRET_NAME || !SECRET_NAME.test(name)) return "invalid";
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "reserved";
  }
  return null;
}

/** Where a secret's sealed value lives: its repo and name are its row. */
export function secretBinding(repoId: string, name: string): Binding {
  return { column: "repo_secrets.encrypted_value", row: `${repoId}/${name}` };
}

/** A value's size as an environment holds it. */
export function valueBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
