import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerApi } from "../api/api.ts";
import type { RestoredReport, SavedPoint } from "../api/protocol.ts";
import { writeDurably } from "../durable.ts";
import type { Transcripts } from "./transcripts.ts";
import type { WorkSaver } from "./work.ts";

/*
 * Checkpoints (docs/cloud.md, "Saving the sandbox"). A sandbox's disk is a cache: it can be lost,
 * and boat.dev has been seen to bring it back as it was at an earlier stop. So after each turn has
 * settled, and before the sandbox sleeps, the runner saves what lives only on that disk (the
 * Claude session's transcript and the checkout's work in progress) where the API keeps it, under
 * a turn marker that only goes up; and keeps the last marker the API confirmed on the disk too.
 *
 * At start, the disk's marker against the API's says what happened: the same or newer, nothing;
 * none at all, a new sandbox (`rebuilt`); an older one, a rollback. Either way the runner puts the
 * checkpoint back before Claude Code resumes, never over anything newer, and tells the API, which
 * logs it with the sandbox and counts the rollbacks.
 */

/** What the disk keeps of the last checkpoint the API confirmed. */
export interface Marker {
  turn: number;
  at: string;
  claudeSessionId: string | null;
  wipCommit: string | null;
  /** The boot that wrote it, to tell boat which boot's writes came back. */
  bootId: string | null;
}

export interface Boot {
  id: string | null;
  at: string | null;
}

export type Recovery = {
  kind: "none" | "rebuilt" | "rollback";
  restored: { session: boolean; workspace: boolean };
};

export interface CheckpointOptions {
  api: RunnerApi;
  /** Where the marker is kept: the runner's state folder. */
  stateDir: string;
  transcripts: Transcripts | null;
  work: WorkSaver | null;
  log(message: string): void;
  /** A structured line for the journal, which is what we would show boat.dev. */
  event(name: string, fields: Record<string, unknown>): void;
  boot(): Boot;
  /** Puts everything written on the disk (`sync`). */
  flush(): Promise<void>;
}

export class Checkpoints {
  /** The highest turn marker this process knows of: the disk's or the API's. */
  private turn = 0;
  private saving: Promise<void> | null = null;
  private again: string | null | undefined = undefined;
  /** What the last checkpoint saved, so an unchanged sandbox saves nothing. */
  private last: string | null = null;

  constructor(private readonly opts: CheckpointOptions) {}

  private get file(): string {
    return join(this.opts.stateDir, "checkpoint.json");
  }

  /** The disk's marker, or null when it has none. */
  marker(): Marker | null {
    if (!existsSync(this.file)) return null;
    try {
      const marker = JSON.parse(readFileSync(this.file, "utf8")) as Marker;
      return typeof marker.turn === "number" ? marker : null;
    } catch {
      return null;
    }
  }

  /**
   * Compares the disk with the API's last checkpoint and, when the disk is behind or empty,
   * restores the transcript and the work in progress from it. Call it once the working folder
   * is ready and before Claude Code starts.
   */
  async recover(saved: SavedPoint | null): Promise<Recovery> {
    const disk = this.marker();
    this.turn = Math.max(disk?.turn ?? 0, saved?.turn ?? 0);
    const restored = { session: false, workspace: false };
    if (!saved || (disk && disk.turn >= saved.turn)) return { kind: "none", restored };
    const kind = disk ? "rollback" : "rebuilt";
    const boot = this.opts.boot();
    const began = Date.now();
    this.opts.log(
      kind === "rollback"
        ? `this disk is at checkpoint ${disk!.turn} (${disk!.at}) but the API has ${saved.turn} (${saved.at}): restoring`
        : `this disk has no checkpoint and the API has ${saved.turn}: restoring`,
    );

    const point = await this.opts.api.restore().catch((err) => {
      this.opts.log(`the checkpoint could not be read back: ${said(err)}`);
      return null;
    });
    // Not marked restored: the next start tries again.
    if (!point?.saved) return { kind, restored };
    const latest = point.saved;
    if (point.session && this.opts.transcripts) {
      try {
        await this.opts.transcripts.unpack(point.session);
        restored.session = true;
      } catch (err) {
        this.opts.log(`the session's transcript could not be restored: ${said(err)}`);
      }
    }
    if (this.opts.work && (latest.wipCommit || point.workspace)) {
      try {
        const work = await this.opts.work.restore(latest, point.workspace);
        restored.workspace = work.done;
        this.opts.log(
          work.done ? `work in progress: ${work.what}` : `work in progress: ${work.why}`,
        );
      } catch (err) {
        this.opts.log(`the work in progress could not be restored: ${said(err)}`);
      }
    }
    this.turn = Math.max(this.turn, latest.turn);
    this.write(latest, boot);
    await this.opts.flush().catch(() => {});

    const report: RestoredReport = {
      kind,
      disk: disk ? { turn: disk.turn, at: disk.at, bootId: disk.bootId } : null,
      saved: { turn: latest.turn, at: latest.at },
      bootId: boot.id,
      bootAt: boot.at,
      restored,
    };
    this.opts.event(kind === "rollback" ? "sandbox_rollback" : "sandbox_rebuilt", {
      ...report,
      ms: Date.now() - began,
    });
    await this.opts.api
      .reportRestored(report)
      .catch((err) => this.opts.log(`reporting the restore failed: ${said(err)}`));
    return { kind, restored };
  }

  /**
   * Saves a checkpoint of the session `sessionId` and the work in progress, unless nothing
   * changed since the last. One at a time: a call while one runs makes one more after it.
   */
  save(sessionId: string | null): Promise<void> {
    if (this.saving) {
      this.again = sessionId;
      return this.saving;
    }
    this.saving = (async () => {
      let next: string | null | undefined = sessionId;
      while (next !== undefined) {
        this.again = undefined;
        try {
          await this.saveOnce(next);
        } catch (err) {
          this.opts.log(`the checkpoint failed: ${said(err)}`);
        }
        next = this.again;
      }
    })().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  private async saveOnce(sessionId: string | null): Promise<void> {
    const { transcripts, work } = this.opts;
    const stamp = [
      sessionId ?? "",
      sessionId && transcripts ? transcripts.stamp(sessionId) : "",
      work ? await work.stamp() : "",
    ].join("#");
    if (stamp === this.last) return;
    const turn = this.turn + 1;
    const session = sessionId && transcripts ? await transcripts.pack(sessionId) : null;
    const saved = work ? await work.save(turn) : null;
    if (saved?.skipped.length)
      this.opts.log(`left out of the checkpoint for their size: ${saved.skipped.join(", ")}`);
    const point = await this.opts.api.saveCheckpoint({
      turn,
      claudeSessionId: session ? sessionId : null,
      wipCommit: saved?.wipCommit ?? null,
      session,
      workspace: saved?.workspace ?? null,
    });
    this.turn = Math.max(turn, point.turn);
    // Another process saved a later one: this one was not recorded, so the disk is not at it.
    if (point.turn !== turn) return;
    this.last = stamp;
    this.write(point, this.opts.boot());
    await this.opts.flush();
  }

  private write(point: SavedPoint, boot: Boot): void {
    const marker: Marker = {
      turn: point.turn,
      at: point.at,
      claudeSessionId: point.claudeSessionId,
      wipCommit: point.wipCommit,
      bootId: boot.id,
    };
    writeDurably(this.file, JSON.stringify(marker));
  }
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
