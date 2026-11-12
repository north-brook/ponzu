import type { SecretLimits } from "@ponzu/db";
import {
  checkSecretName,
  MAX_SECRET_NAME,
  reservedSecretReason,
  SECRET_NAME,
} from "@ponzu/runner/protocol";
import { z } from "zod";
import type { Binding } from "../vault/vault.ts";

/*
 * A repo's secrets (docs/cloud.md, "Environments"): what may be one, and how one is sealed.
 * A secret reaches the agent's side of every sandbox of the repo's canvases as an environment
 * variable, beside Ponzu's own and the canvas owner's Claude credential, so a name that would
 * replace or steer those, or change how a program there loads code or checks TLS, is refused:
 * on the way in, and again when a sandbox's environment is made. The rule itself is the runner
 * protocol's (`checkSecretName`), so the runner's `request_secret` refuses the same names before
 * it asks anyone.
 */

export { MAX_SECRET_NAME, SECRET_NAME };

/** 16 KiB: a private key or a service account's JSON fits. */
export const MAX_SECRET_BYTES = 16 * 1024;

/**
 * What one repo's secrets may hold. They travel to a sandbox in one variable, each value in
 * base64 (`sandboxes/environment.ts`), and the runner's start command carries at most 64 KB of
 * environment: Ponzu's own cap, under Linux's 128 KiB for one variable (a 64 KB command env was
 * accepted live, 128 KB in one variable refused). 44 KiB of names and values is 60 KB encoded,
 * which leaves room for Ponzu's own.
 */
export const SECRET_LIMITS: SecretLimits = { count: 50, totalBytes: 44 * 1024 };

/** Why a name can't be a secret's, or null when it can. */
export const secretNameProblem = checkSecretName;

/**
 * Why a reserved name is, in words for the person who typed it: the prefix it starts with, or
 * that the sandbox itself depends on the name.
 */
export const reservedReason = reservedSecretReason;

/** Where a secret's sealed value lives: its repo and name are its row. */
export function secretBinding(repoId: string, name: string): Binding {
  return { column: "repo_secrets.encrypted_value", row: `${repoId}/${name}` };
}

/** A value's size as an environment holds it. */
export function valueBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** A secret's value as a person gives it: 1 byte to `MAX_SECRET_BYTES`, with no NUL. */
export const SecretValue = z
  .string()
  .min(1, "A secret needs a value.")
  .refine((value) => !value.includes("\u0000"), "A secret's value cannot hold a NUL character.")
  .refine(
    (value) => valueBytes(value) <= MAX_SECRET_BYTES,
    `A secret's value is at most ${MAX_SECRET_BYTES / 1024} KB.`,
  );
