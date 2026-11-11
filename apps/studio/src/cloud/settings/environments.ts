import type { Repo } from "../model.ts";

/*
 * A repo's environment: the base Claude built on its first run there (shown by its stack), and
 * the secrets its sandboxes receive. A secret's value is never read back, only replaced.
 */

/** A runtime, package manager or service of a base: a Simple Icons slug and its label. */
export interface StackItem {
  slug: string;
  /** "Node 22" */
  label: string;
}

export interface Secret {
  name: string;
  updatedAt: string;
}

export interface RepoEnvironment {
  repo: Repo;
  base: {
    status: "ready" | "building" | "failed";
    /** When the base in use was built: kept through a rebuild, and through one that failed. */
    builtAt: string | null;
    stack: StackItem[];
  };
  secrets: Secret[];
}

/** What a stored secret shows in place of its value: twelve bullets, whatever its length. */
export const SECRET_MASK = "••••••••••••";

/**
 * A secret's name as it is typed: capitals, digits and underscores, the way an environment
 * variable is written. Lowercase is raised, spaces and dashes become underscores, the rest drop.
 */
export function secretName(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[\s-]/g, "_")
    .replace(/[^A-Z0-9_]/g, "");
}

/** Why a name can't be saved, or null when it can. An empty name is just not ready. */
export function secretNameError(
  name: string,
  secrets: Secret[],
  editing: string | null = null,
): string | null {
  if (/^[0-9]/.test(name)) return "Starts with a letter";
  if (secrets.some((s) => s.name === name && s.name !== editing)) return `${name} is already here`;
  return null;
}

/** A new secret can be saved once it has a name, no error, and a value. */
export function canSaveSecret(name: string, value: string, secrets: Secret[]): boolean {
  return name.length > 0 && value.length > 0 && secretNameError(name, secrets) === null;
}
