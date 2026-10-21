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
  /**
   * Set when the tool broke, though it still had something to give back
   * (screenshot's lint without its image). Counted as a crash of this class,
   * at this render stage.
   */
  failure?: ErrorClass;
  stage?: "queue" | "load" | "assets" | "prepare" | "lint" | "capture";
}

/**
 * Why a call failed, coarsely, for telemetry. A fixed list, never words from
 * an error message, which can carry ids and names from the person's design.
 */
export type ErrorClass =
  | "invalid_target"
  | "file_ambiguous"
  | "file_name_ambiguous"
  | "file_ids_ambiguous"
  | "file_ids_split"
  | "file_not_found"
  | "host_unreachable"
  | "host_unresponsive"
  | "host_busy"
  | "timeout"
  | "capture_failed"
  | "render_error"
  | "aborted"
  | "unknown";

const RENDER_CLASSES = new Set<ErrorClass>([
  "host_unreachable",
  "host_unresponsive",
  "host_busy",
  "timeout",
  "capture_failed",
  "render_error",
]);
const STAGES = new Set(["queue", "load", "assets", "prepare", "lint", "capture"]);

/** A failed render (`RenderError` from @ponzu/render): its class and where it stalled. */
function renderFailure(err: unknown): { error_class: ErrorClass; stage?: string } | null {
  const e = err as { name?: string; failure?: unknown; stage?: unknown } | null;
  if (e?.name !== "RenderError") return null;
  const cls = RENDER_CLASSES.has(e.failure as ErrorClass) ? (e.failure as ErrorClass) : "unknown";
  return {
    error_class: cls,
    ...(STAGES.has(e.stage as string) ? { stage: e.stage as string } : {}),
  };
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
  /** Counted in telemetry in place of invalid_target, for mistakes worth telling apart. */
  code?: ErrorClass;

  constructor(message: string, code?: ErrorClass) {
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
    why?: { error_class: ErrorClass; stage?: string },
  ) => {
    try {
      ctx.ws.telemetry?.capture("tool called", {
        tool: def.name,
        group: def.group,
        outcome,
        duration_ms: Date.now() - started,
        client: ctx.caller.client,
        ...(call.resolved ? { file_from: call.resolved.from } : {}),
        ...why,
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
    const { failure, stage, ...result } = await def.handler(parsed.data, call);
    if (failure) track("crash", { error_class: failure, ...(stage ? { stage } : {}) });
    else track(result.isError ? "tool_error" : "ok");
    const note = call.resolved?.note;
    return note ? { ...result, text: result.text + note } : result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const known = err instanceof ToolError || (err as Error)?.name === "OpError";
    // A call can fail after its ids moved the session; the agent still needs to hear it moved.
    const note = call.resolved?.note ?? "";
    if (known) {
      track("mistake", {
        error_class: err instanceof ToolError && err.code ? err.code : "invalid_target",
      });
      return { text: message + note, isError: true };
    }
    const render = renderFailure(err);
    const aborted = (err as Error)?.name === "AbortError";
    track("crash", render ?? { error_class: aborted ? "aborted" : "unknown" });
    // A failed render already says what stalled, in words meant for the agent.
    return { text: (render ? message : `${def.name} failed: ${message}`) + note, isError: true };
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
