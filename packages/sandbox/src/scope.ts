/*
 * The scope guard: the wall between environments that share one Vercel project.
 *
 * Dev and production are one project, ponzu-api (dev is its custom environment `dev`). Vercel
 * Sandbox authenticates per project, not per environment: a function's OIDC token names the
 * project, and with it dev's functions could list, stop, delete and run commands in
 * production's sandboxes, which hold people's repositories and work in progress
 * (https://vercel.com/docs/vercel-sandbox/concepts/authentication and
 * https://vercel.com/docs/oidc/reference, read 2026-11-12). Nothing at Vercel keeps them apart.
 * This module does: every call names a sandbox, and a module made for one scope refuses any
 * name outside `pz-<scope>-` before a request leaves the process, with `out_of_scope`.
 *
 * It guards against a mistake in our own code (a wrong name, a listing someone widens), not
 * against code written to get round it: such code could make a module for another scope. That
 * is why the SDK is reachable only through this package (surface.test.ts). A scope is the
 * database's (sandboxScope in apps/api/src/env.ts), and production's database is not dev's, so
 * production's scope is not dev's or a preview's.
 */

import { SandboxError } from "./errors.ts";
import { isOwnedName, ownedPrefix } from "./names.ts";
import type {
  At,
  CallOptions,
  Command,
  ExecResult,
  Sandboxes,
  SandboxInfo,
  SandboxSpec,
  Up,
} from "./sandboxes.ts";

/**
 * `inner`, refusing every call on a name outside `scope`'s prefix (`pz-<scope>-`, or `pz-test-`
 * for CHECK_SCOPE) and every listing that is not inside it. A listing that answers a name
 * outside it throws too, rather than drop it quietly: the caller learns its view is wrong.
 */
export function scopedSandboxes(inner: Sandboxes, scope: string): Sandboxes {
  return new ScopedSandboxes(inner, ownedPrefix(scope));
}

class ScopedSandboxes implements Sandboxes {
  readonly #inner: Sandboxes;
  readonly #prefix: string;

  constructor(inner: Sandboxes, prefix: string) {
    this.#inner = inner;
    this.#prefix = prefix;
  }

  /** Throws `out_of_scope` unless `name` is one of this scope's. */
  #own(op: string, name: string): void {
    if (!isOwnedName(this.#prefix, name)) {
      throw new SandboxError(
        "out_of_scope",
        `${op}: ${JSON.stringify(name)} is not a ${this.#prefix} name; nothing was sent`,
      );
    }
  }

  // Each method checks before it calls `inner`, and calls it through `this.#inner` at call
  // time, so a test that replaces a method on the inner fake still goes through the guard.

  async up(name: string, spec: SandboxSpec, options?: CallOptions): Promise<Up> {
    this.#own("up", name);
    return this.#inner.up(name, spec, options);
  }

  async status(name: string, options?: CallOptions): Promise<SandboxInfo | null> {
    this.#own("status", name);
    return this.#inner.status(name, options);
  }

  async list(prefix: string, options?: CallOptions): Promise<SandboxInfo[]> {
    // The prefix itself, or a narrower one inside it (`pz-<scope>-signin-`). A wider one
    // (`pz-`, or `pz-<scope>` without its dash) would take in other scopes' names.
    if (!prefix.startsWith(this.#prefix) || !/^[a-zA-Z0-9_-]+$/.test(prefix)) {
      throw new SandboxError(
        "out_of_scope",
        `list: ${JSON.stringify(prefix)} is not inside ${this.#prefix}; nothing was sent`,
      );
    }
    const listed = await this.#inner.list(prefix, options);
    const stray = listed.find(
      (info) => !isOwnedName(this.#prefix, info.name) || !info.name.startsWith(prefix),
    );
    if (stray) {
      throw new SandboxError(
        "out_of_scope",
        `list: Vercel answered ${JSON.stringify(stray.name)} for ${JSON.stringify(prefix)}`,
      );
    }
    return listed;
  }

  async start(at: At, command: Command, options?: CallOptions): Promise<{ commandId: string }> {
    this.#own("start", at.name);
    return this.#inner.start(at, command, options);
  }

  async exec(
    at: At,
    command: Command & { timeoutMs: number },
    options?: CallOptions,
  ): Promise<ExecResult> {
    this.#own("exec", at.name);
    return this.#inner.exec(at, command, options);
  }

  async writeFile(
    at: At,
    path: string,
    content: string | Uint8Array,
    options?: CallOptions & { mode?: number },
  ): Promise<void> {
    this.#own("writeFile", at.name);
    return this.#inner.writeFile(at, path, content, options);
  }

  async readFile(at: At, path: string, options?: CallOptions): Promise<Uint8Array | null> {
    this.#own("readFile", at.name);
    return this.#inner.readFile(at, path, options);
  }

  async extend(at: At, ms: number, options?: CallOptions): Promise<number | null> {
    this.#own("extend", at.name);
    return this.#inner.extend(at, ms, options);
  }

  async stop(
    at: At,
    options?: CallOptions,
  ): Promise<{ stopped: boolean; snapshotBytes: number | null }> {
    this.#own("stop", at.name);
    return this.#inner.stop(at, options);
  }

  async remove(name: string, options?: CallOptions): Promise<void> {
    this.#own("remove", name);
    return this.#inner.remove(name, options);
  }
}
