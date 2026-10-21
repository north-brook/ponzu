import { z } from "zod";
import type { ToolContext } from "./context.ts";

export interface ToolImage {
  /** Base64 data. */
  data: string;
  mime: string;
}

export interface ToolResult {
  text: string;
  images?: ToolImage[];
  isError?: boolean;
  /** Structured result for hosts that want it (the AI SDK, tests). */
  data?: unknown;
}

export type ToolGroup = "orient" | "write" | "see" | "organize" | "converse" | "listen";

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  group: ToolGroup;
  description: string;
  input: S;
  /** No side effects. */
  readOnly?: boolean;
  /** Deletes or replaces content. */
  destructive?: boolean;
  handler(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** A mistake the agent can fix. Shown as a tool error, not a crash. */
export class ToolError extends Error {
  /** A short name for the kind of mistake, counted in telemetry. Never content or paths. */
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ToolError";
    if (code) this.code = code;
  }
}

export async function runTool(
  def: ToolDef<any>,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const started = Date.now();
  // Its own copy, so what this call resolved never leaks into another's.
  const call: ToolContext = { ...ctx, resolved: undefined };
  // Which tools agents use and how they fail; never the arguments or the result.
  const track = (
    outcome: "ok" | "invalid_args" | "tool_error" | "mistake" | "crash",
    error?: string,
  ) => {
    try {
      ctx.ws.telemetry?.capture("tool called", {
        tool: def.name,
        group: def.group,
        outcome,
        duration_ms: Date.now() - started,
        client: ctx.caller.client,
        ...(call.resolved ? { file_from: call.resolved.from } : {}),
        ...(error ? { error } : {}),
      });
    } catch {
      // Counting a call never changes its result.
    }
  };
  const parsed = z.object(def.input).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    track("invalid_args");
    return { text: `Invalid arguments for ${def.name}: ${issues}`, isError: true };
  }
  try {
    ctx.ws.presence.touch(ctx.caller);
    const result = await def.handler(parsed.data, call);
    track(result.isError ? "tool_error" : "ok");
    const note = call.resolved?.note;
    return note && !result.isError ? { ...result, text: result.text + note } : result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const known = err instanceof ToolError || (err as Error)?.name === "OpError";
    track(known ? "mistake" : "crash", err instanceof ToolError ? err.code : undefined);
    return { text: known ? message : `${def.name} failed: ${message}`, isError: true };
  }
}

/** JSON Schema for hosts that don't speak zod. */
export function jsonSchema(def: ToolDef<any>): Record<string, unknown> {
  return z.toJSONSchema(z.object(def.input), { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}

/* Shared argument shapes */

export const fileArg = z
  .string()
  .optional()
  .describe(
    "Which .design, by path or name. Omit to use the file that holds the ids you pass, else the one you last created, named or edited in this session.",
  );

export const styleValue = z.union([z.string(), z.number(), z.null()]);

export const styleArg = z
  .record(z.string(), styleValue)
  .describe(
    'CSS declarations, camelCase or kebab-case. Numbers, and numeric strings like "24", get px where CSS needs a unit. null removes. Example: {"padding": 24, "backgroundColor": "var(--color-ink)"}',
  );
