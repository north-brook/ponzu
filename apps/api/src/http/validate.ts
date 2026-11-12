import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";
import { ApiError } from "./errors.ts";

/**
 * Checks one part of a request (`json`, `query`, `param`, `header`) against a zod schema
 * before the handler runs. The handler reads the parsed value with `c.req.valid(target)`, and
 * the schema's types reach the typed client. A request that does not fit is refused with 400
 * `invalid_request`; `details.issues` names each field and what is wrong with it, and never
 * repeats the value that was sent.
 */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (result.success) return;
    throw new ApiError(400, "invalid_request", "The request is not what this route takes.", {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: [target, ...issue.path].join("."),
          message: issue.message,
        })),
      },
    });
  });
}
