import { previewArtboard, type Replica } from "@ponzu/core";
import type { Renderer } from "@ponzu/render";
import type { ReplicaDesign } from "@ponzu/tools";
import type { RunnerApi, UploadFile } from "./api/api.ts";

const THEMES = ["light", "dark"] as const;

/**
 * The pictures of the design the sidebar and the phone show: its first page, in each theme,
 * drawn once the edits have stopped for a moment and reached the API, and uploaded with the
 * seq they show. A failure is logged and waits for the next edit.
 */
export class Previews {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private shown = -1;

  constructor(
    private readonly opts: {
      replica: Replica;
      design: ReplicaDesign;
      renderer: Renderer;
      api: RunnerApi;
      assetBase: string;
      delayMs: number;
      settleMs: number;
      log(message: string): void;
    },
  ) {}

  /** The design changed: draw it again once it has been still for a moment. */
  changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draw();
    }, this.opts.delayMs);
    this.timer.unref?.();
  }

  /** Wait for a drawing under way. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private draw(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.upload()
      .catch((err) => this.opts.log(`preview failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.draw();
        }
      });
  }

  private async upload(): Promise<void> {
    const { replica, design, renderer, api, assetBase } = this.opts;
    // The picture should show what everyone else will load, so what the agent drew goes first.
    await design.settled(this.opts.settleMs);
    const seq = replica.seq;
    if (seq === this.shown) return;
    const doc = replica.doc;
    const files: UploadFile[] = [];
    for (const theme of THEMES) {
      const artboard = previewArtboard(doc, theme);
      if (!artboard) return;
      const shot = await renderer.render({
        artboard,
        tokens: doc.tokens,
        colorScheme: theme,
        format: "png",
        thumbnail: true,
        assetBase,
      });
      files.push({
        purpose: "preview",
        name: `${theme}.png`,
        contentType: shot.mime,
        bytes: shot.bytes,
      });
    }
    await api.upload(files, { seq });
    this.shown = seq;
  }
}
