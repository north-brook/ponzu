import { clampScale } from "./capture.ts";
import { artboardPage } from "./document.ts";
import type { FilmDriver } from "./film.ts";
import {
  type Box,
  type FrameDriver,
  FULL_LINT_SCRIPT,
  type MotionInfo,
  prepareScript,
  recordFrames,
} from "./motion.ts";
import {
  type LintIssue,
  type MeasureRequest,
  type MeasureResult,
  measureScript,
  type RecordRequest,
  type RecordResult,
  type Renderer,
  type RenderRequest,
  type RenderResult,
} from "./renderer.ts";
import { HOST_DEADLINE_MS, RENDER_FAILURES, RenderError, type RenderStage } from "./stages.ts";

/**
 * What a render host receives: a complete page plus where to look. The
 * desktop app implements this with an offscreen Electron window.
 */
export interface RemoteRenderJob {
  html: string;
  width: number;
  height: number;
  /** CSS selector of the element to capture. */
  selector: string;
  scale: number;
  format: "png" | "jpeg" | "pdf";
  lint: boolean;
  lintScript: string;
  /** Evaluate after fonts load and before measuring: holds animations at the requested time. */
  prepareScript?: string;
  /** The media preference to emulate, for prefers-color-scheme. Older hosts ignore it. */
  colorScheme?: "light" | "dark";
}

export interface RemoteRenderReply {
  /** Base64 image or PDF bytes. */
  data: string;
  mime: string;
  width: number;
  height: number;
  contentHeight: number;
  /** The scale the image is at, when the host had to use less than the job's. */
  scale?: number;
  issues: LintIssue[];
  /** What prepareScript evaluated to. */
  motion?: MotionInfo | { error: string };
  /** Fonts or images ran out of time; the render went on without them. */
  assetsTimedOut?: boolean;
  /** Lint ran but the capture failed: `data` is empty. */
  captureError?: string;
}

/** What a render host answers with a 500. Older hosts sent the message as plain text. */
export interface RemoteRenderFailure {
  error: string;
  failure?: string;
  stage?: RenderStage;
}

/**
 * Recording drives one live page step by step. A host that can record also
 * answers these at `session` next to its render endpoint.
 */
export type RemoteSessionRequest =
  | {
      op: "open";
      html: string;
      width: number;
      height: number;
      /** The media preference to emulate, for prefers-color-scheme. */
      colorScheme?: "light" | "dark";
    }
  | { op: "eval"; session: string; expression: string }
  /** Reply data: base64 PNG of `box` (CSS px) at `scale` device px per CSS px. */
  | { op: "capture"; session: string; box: Box; scale: number }
  | { op: "show"; session: string; html: string; width: number; height: number }
  | { op: "close"; session: string }
  /**
   * A timelapse film page: a real URL on the server, at a device scale, kept
   * until closed. Evals then drive it; `frame` captures the viewport. Hosts
   * from before timelapses answer 404 or an unknown-op error.
   */
  | { op: "film"; url: string; width: number; height: number; scale: number }
  /** Reply data: the whole viewport, base64, at the film's scale. */
  | { op: "frame"; session: string; format: "png" | "jpeg" };

export interface RemoteSessionReply {
  session?: string;
  /** On open: fonts or images ran out of time, and the page went on without them. */
  assetsTimedOut?: boolean;
  value?: unknown;
  data?: string;
}

export interface RemoteOptions {
  /** How long to wait for the host to answer one request. Default HOST_DEADLINE_MS. */
  deadlineMs?: number;
}

/** Renders by POSTing jobs to a render host (`PONZU_RENDER_ENDPOINT`). */
export class RemoteRenderer implements Renderer {
  private deadlineMs: number;

  constructor(
    private endpoint: string,
    private token?: string,
    private assetBase?: string,
    opts: RemoteOptions = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? HOST_DEADLINE_MS;
  }

  /**
   * One request with a deadline. Without it a host that never answered held
   * the call until the runtime's own fetch timeout, six minutes, which said
   * nothing about why.
   */
  private async post<T>(url: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.deadlineMs),
      });
    } catch (err) {
      throw unreachable(err, this.deadlineMs);
    }
    if (!res.ok) throw await failed(res);
    // The deadline covers the body too: a host can answer, then stall mid-reply.
    try {
      return (await res.json()) as T;
    } catch (err) {
      const name = (err as Error | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw unreachable(err, this.deadlineMs);
      throw err;
    }
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    const job: RemoteRenderJob = {
      html: this.page(req),
      ...size(req.artboard.root.style),
      selector: selectorFor(req.nodeId),
      scale: clampScale(req.scale),
      format: req.format ?? "png",
      lint: req.lint ?? false,
      lintScript: FULL_LINT_SCRIPT,
      prepareScript: prepareScript({ interact: req.interact, at: req.at }),
      colorScheme: req.colorScheme,
    };
    const out = await this.post<RemoteRenderReply>(this.endpoint, job);
    if (out.motion && "error" in out.motion) throw new Error(out.motion.error);
    if (out.captureError && !job.lint)
      throw new RenderError(out.captureError, "capture_failed", "capture");
    return {
      bytes: fromBase64(out.data),
      mime: out.mime,
      width: out.width,
      height: out.height,
      contentHeight: out.contentHeight,
      // Hosts from before this field always captured at the job's scale.
      scale: out.scale ?? job.scale,
      issues: out.issues,
      motion: out.motion,
      assetsTimedOut: out.assetsTimedOut,
      captureError: out.captureError,
    };
  }

  private sessionCall(cant: string) {
    const url = new URL("session", this.endpoint).href;
    return async (op: RemoteSessionRequest): Promise<RemoteSessionReply> => {
      try {
        return await this.post<RemoteSessionReply>(url, op);
      } catch (err) {
        if (err instanceof RenderError && err.status === 404) throw new Error(cant);
        throw err;
      }
    };
  }

  /** Over the recording session API, so any host that can record can measure. */
  async measure(req: MeasureRequest): Promise<MeasureResult> {
    const call = this.sessionCall("This render host can't measure layout.");
    const { session } = await call({
      op: "open",
      html: this.page(req),
      ...size(req.artboard.root.style),
      colorScheme: req.colorScheme,
    });
    if (!session) throw new Error("Render host didn't open a session.");
    try {
      const eval_ = async <T>(expression: string) =>
        (await call({ op: "eval", session, expression })).value as T;
      const motion = await eval_<MotionInfo | { error: string }>(prepareScript({}));
      if (motion && "error" in motion) throw new Error(motion.error);
      const out = await eval_<MeasureResult | null>(measureScript(req.ids));
      if (!out) throw new Error("The artboard didn't render.");
      return out;
    } finally {
      await call({ op: "close", session }).catch(() => {});
    }
  }

  async record(req: RecordRequest): Promise<RecordResult> {
    const call = this.sessionCall("This render host can't record animation.");
    const { session, assetsTimedOut } = await call({
      op: "open",
      html: this.page(req),
      ...size(req.artboard.root.style),
      colorScheme: req.colorScheme,
    });
    if (!session) throw new Error("Render host didn't open a session.");
    const driver: FrameDriver = {
      evaluate: async <T>(expression: string) =>
        (await call({ op: "eval", session, expression })).value as T,
      capture: async (box, scale) =>
        fromBase64((await call({ op: "capture", session, box, scale })).data ?? ""),
      show: async (html, width, height) => {
        await call({ op: "show", session, html, width, height });
      },
    };
    try {
      const out = await recordFrames(driver, {
        selector: selectorFor(req.nodeId),
        interact: req.interact,
        frames: req.frames,
        from: req.from,
        to: req.to,
        scroll: req.scroll,
        lint: req.lint,
      });
      return { ...out, mime: "image/png", ...(assetsTimedOut ? { assetsTimedOut } : {}) };
    } finally {
      await call({ op: "close", session }).catch(() => {});
    }
  }

  /** A film page in the host, over the session API (desktop: an offscreen window). */
  async filmDriver(): Promise<FilmDriver> {
    const call = this.sessionCall(
      "This version of the Ponzu app can't make timelapses. Update it.",
    );
    let session: string | undefined;
    return {
      async open(url, width, height, scale) {
        session = (await call({ op: "film", url, width, height, scale })).session;
        if (!session) throw new Error("Render host didn't open a film page.");
      },
      async evaluate<T>(expression: string) {
        return (await call({ op: "eval", session: session!, expression })).value as T;
      },
      async capture(format) {
        return (await call({ op: "frame", session: session!, format })).data ?? "";
      },
      async close() {
        if (session) await call({ op: "close", session }).catch(() => {});
        session = undefined;
      },
    };
  }

  private page(req: {
    artboard: RenderRequest["artboard"];
    tokens: string;
    colorScheme?: "light" | "dark";
    assetBase?: string;
  }) {
    return artboardPage(req.artboard, {
      tokens: req.tokens,
      assetBase: req.assetBase ?? this.assetBase,
      colorScheme: req.colorScheme,
    });
  }

  async close(): Promise<void> {}
}

/** A request that got no answer: the host isn't there, or didn't reply in time. */
function unreachable(err: unknown, deadlineMs: number): RenderError {
  const name = (err as Error | null)?.name;
  if (name === "TimeoutError" || name === "AbortError")
    return new RenderError(
      `Ponzu's renderer didn't answer within ${Math.round(deadlineMs / 1000)}s. The Ponzu app may be busy or waiting on a dialog; ask the person to check it, then try again.`,
      "host_unresponsive",
    );
  return new RenderError(
    "Ponzu's renderer isn't running (the app may be restarting or updating). Try again in a moment.",
    "host_unreachable",
  );
}

/** A host's error reply, with the step that failed when the host says. */
async function failed(res: Response): Promise<RenderError> {
  const text = await res.text().catch(() => "");
  let body: RemoteRenderFailure | null = null;
  try {
    body = JSON.parse(text) as RemoteRenderFailure;
  } catch {}
  const failure = RENDER_FAILURES.find((f) => f === body?.failure) ?? "render_error";
  const message = body?.error ?? `Render host: ${res.status} ${text}`;
  return new RenderError(message, failure, body?.stage, res.status);
}

function size(style: Record<string, string>): { width: number; height: number } {
  const px = (v?: string) => (v && /^\d+(\.\d+)?px$/.test(v) ? Number.parseFloat(v) : null);
  return { width: px(style.width) ?? 1440, height: px(style.height) ?? 900 };
}

function selectorFor(nodeId?: string): string {
  return nodeId ? `[data-id="${nodeId.replace(/"/g, '\\"')}"]` : "[data-artboard]";
}

function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
