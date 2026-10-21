import { clampScale } from "./capture.ts";
import { artboardPage } from "./document.ts";
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
}

/**
 * Recording drives one live page step by step. A host that can record also
 * answers these at `session` next to its render endpoint.
 */
export type RemoteSessionRequest =
  | { op: "open"; html: string; width: number; height: number }
  | { op: "eval"; session: string; expression: string }
  /** Reply data: base64 PNG of `box` (CSS px) at `scale` device px per CSS px. */
  | { op: "capture"; session: string; box: Box; scale: number }
  | { op: "show"; session: string; html: string; width: number; height: number }
  | { op: "close"; session: string };

export interface RemoteSessionReply {
  session?: string;
  value?: unknown;
  data?: string;
}

/** Renders by POSTing jobs to a render host (`PONZU_RENDER_ENDPOINT`). */
export class RemoteRenderer implements Renderer {
  constructor(
    private endpoint: string,
    private token?: string,
    private assetBase?: string,
  ) {}

  private post(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
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
    };
    const res = await this.post(this.endpoint, job);
    if (!res.ok) throw new Error(`Render host: ${res.status} ${await res.text()}`);
    const out = (await res.json()) as RemoteRenderReply;
    if (out.motion && "error" in out.motion) throw new Error(out.motion.error);
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
    };
  }

  private sessionCall(cant: string) {
    const url = new URL("session", this.endpoint).href;
    return async (op: RemoteSessionRequest): Promise<RemoteSessionReply> => {
      const res = await this.post(url, op);
      if (res.status === 404) throw new Error(cant);
      if (!res.ok) throw new Error(`Render host: ${res.status} ${await res.text()}`);
      return (await res.json()) as RemoteSessionReply;
    };
  }

  /** Over the recording session API, so any host that can record can measure. */
  async measure(req: MeasureRequest): Promise<MeasureResult> {
    const call = this.sessionCall("This render host can't measure layout.");
    const { session } = await call({
      op: "open",
      html: this.page(req),
      ...size(req.artboard.root.style),
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
    const { session } = await call({
      op: "open",
      html: this.page(req),
      ...size(req.artboard.root.style),
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
      return { ...out, mime: "image/png" };
    } finally {
      await call({ op: "close", session }).catch(() => {});
    }
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

function size(style: Record<string, string>): { width: number; height: number } {
  const px = (v?: string) => (v && /px$/.test(v) ? Number.parseFloat(v) : null);
  return { width: px(style.width) ?? 1440, height: px(style.height) ?? 900 };
}

function selectorFor(nodeId?: string): string {
  return nodeId ? `[data-id="${nodeId.replace(/"/g, '\\"')}"]` : "[data-artboard]";
}

function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}
