/*
 * Sandbox names. A name is unique per Vercel project and is the only identifier we keep: the
 * API's database scope keeps environments sharing one project apart.
 *
 *   pz-<scope>-<designId>             a design
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

/** `pz-${scope}-${designId}`. */
export function designSandboxName(scope: string, designId: string): string {
  if (designId.startsWith("signin-")) throw new Error(`a design id cannot start with signin-`);
  return checked(`${scopePrefix(scope)}${designId}`);
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
  kind: "design" | "signin";
  id: string;
}

/** The parts of a design or sign-in name; null for anything else, test names included. */
export function parseSandboxName(name: string): ParsedSandboxName | null {
  const match = /^pz-([0-9a-f]{12})-(.+)$/.exec(name);
  if (!match || !PART.test(name)) return null;
  const [, scope, rest] = match as unknown as [string, string, string];
  if (rest.startsWith("signin-")) {
    const id = rest.slice("signin-".length);
    return id ? { scope, kind: "signin", id } : null;
  }
  return { scope, kind: "design", id: rest };
}
