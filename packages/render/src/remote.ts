import { artboardPage } from "./document.ts";
import {
  LINT_SCRIPT,
  type LintIssue,
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
}

export interface RemoteRenderReply {
  /** Base64 image or PDF bytes. */
  data: string;
  mime: string;
  width: number;
  height: number;
  contentHeight: number;
  issues: LintIssue[];
}

/** Renders by POSTing jobs to a render host (`PONZU_RENDER_ENDPOINT`). */
export class RemoteRenderer implements Renderer {
  constructor(
    private endpoint: string,
    private token?: string,
    private assetBase?: string,
  ) {}

  async render(req: RenderRequest): Promise<RenderResult> {
    const px = (v?: string) => (v && /px$/.test(v) ? Number.parseFloat(v) : null);
    const job: RemoteRenderJob = {
      html: artboardPage(req.artboard, {
        tokens: req.tokens,
        assetBase: this.assetBase,
        colorScheme: req.colorScheme,
      }),
      width: px(req.artboard.root.style.width) ?? 1440,
      height: px(req.artboard.root.style.height) ?? 900,
      selector: req.nodeId ? `[data-id="${req.nodeId.replace(/"/g, '\\"')}"]` : "[data-artboard]",
      scale: req.scale ?? 1,
      format: req.format ?? "png",
      lint: req.lint ?? false,
      lintScript: LINT_SCRIPT,
    };
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(job),
    });
    if (!res.ok) throw new Error(`Render host: ${res.status} ${await res.text()}`);
    const out = (await res.json()) as RemoteRenderReply;
    return {
      bytes: Uint8Array.from(atob(out.data), (c) => c.charCodeAt(0)),
      mime: out.mime,
      width: out.width,
      height: out.height,
      contentHeight: out.contentHeight,
      issues: out.issues,
    };
  }

  async close(): Promise<void> {}
}
