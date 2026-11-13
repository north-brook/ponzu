/*
 * Sandbox names. A name is unique per Vercel project and is the only identifier we keep: the
 * API's database scope keeps environments sharing one project apart. Dev and production share
 * the ponzu-api project, and Vercel gives dev's functions a token that can reach every sandbox
 * in it, so the scope is the wall: `scopedSandboxes` (scope.ts) refuses every call on a name
 * outside the caller's own prefix.
 *
 *   pz-<scope>-<canvasId>             a canvas
 *   pz-<scope>-signin-<authStateId>   a Claude sign-in
 *   pz-test-<tag>-<8 random>          live suites and image checks; no sweep matches it
 *
 * Vercel allows `^[a-zA-Z0-9_-]+$` up to 128 characters.
 */

const SCOPE = /^[0-9a-f]{12}$/;
const PART = /^[a-zA-Z0-9_-]+$/;
const MAX_NAME = 128;

function checked(name: string): string {
  if (name.length > MAX_NAME || !PART.test(name)) {
    throw new Error(`not a valid sandbox name: ${JSON.stringify(name)}`);
  }
  return name;
}

function checkScope(scope: string): void {
  if (!SCOPE.test(scope)) throw new Error(`a sandbox scope is 12 hex characters, not ${scope}`);
}

/** "pz-<scope>-". scope = sandboxScope(DATABASE_URL), 12 hex. */
export function scopePrefix(scope: string): string {
  checkScope(scope);
  return `pz-${scope}-`;
}

/**
 * The scope of the live suites' and image checks' names (`testSandboxName`, `pz-test-…`). It is
 * not hex, so no database's scope can ever be it, and a module made with it can touch only
 * `pz-test-` names.
 */
export const CHECK_SCOPE = "test";

/**
 * The names a module made for `scope` may touch: `pz-<scope>-` for a database's 12 hex, or
 * `pz-test-` for CHECK_SCOPE. Anything else throws. The trailing dash is part of it, so one
 * scope's prefix is never the start of another's.
 */
export function ownedPrefix(scope: string): string {
  return scope === CHECK_SCOPE ? `pz-${CHECK_SCOPE}-` : scopePrefix(scope);
}

/** Whether `name` is a valid sandbox name under `prefix` (from ownedPrefix), with something after it. */
export function isOwnedName(prefix: string, name: string): boolean {
  return (
    name.length > prefix.length &&
    name.length <= MAX_NAME &&
    name.startsWith(prefix) &&
    PART.test(name)
  );
}

/** `pz-${scope}-${canvasId}`. */
export function canvasSandboxName(scope: string, canvasId: string): string {
  if (canvasId.startsWith("signin-")) throw new Error(`a canvas id cannot start with signin-`);
  return checked(`${scopePrefix(scope)}${canvasId}`);
}

/** `pz-${scope}-signin-${authStateId}`. */
export function signInSandboxName(scope: string, authStateId: string): string {
  return checked(`${scopePrefix(scope)}signin-${authStateId}`);
}

const RANDOM = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `pz-test-${tag}-${8 random [a-z0-9]}`: live suites and image checks; matched by no sweep. */
export function testSandboxName(tag: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const suffix = Array.from(bytes, (byte) => RANDOM[byte % RANDOM.length]).join("");
  return checked(`pz-test-${tag}-${suffix}`);
}

export interface ParsedSandboxName {
  scope: string;
  kind: "canvas" | "signin";
  id: string;
}

/** The parts of a canvas or sign-in name; null for anything else, test names included. */
export function parseSandboxName(name: string): ParsedSandboxName | null {
  const match = /^pz-([0-9a-f]{12})-(.+)$/.exec(name);
  if (!match || !PART.test(name)) return null;
  const [, scope, rest] = match as unknown as [string, string, string];
  if (rest.startsWith("signin-")) {
    const id = rest.slice("signin-".length);
    return id ? { scope, kind: "signin", id } : null;
  }
  return { scope, kind: "canvas", id: rest };
}
