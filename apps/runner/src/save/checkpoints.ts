import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerApi } from "../api/api.ts";
import type { RestoredReport, SavedPoint } from "../api/protocol.ts";
import { writeDurably } from "../durable.ts";
import type { HeldMark } from "./held.ts";
import { type Transcripts, TranscriptTooLarge } from "./transcripts.ts";
import type { SavedWork, WorkSaver } from "./work.ts";

/*
 * Checkpoints (docs/cloud.md, "Saving the sandbox"). A sandbox's disk is a cache: its snapshot
 * expires, an image change recreates it, and a host can be lost under it. So after each turn has
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
  /** The boot that wrote it, to tell which boot's writes came back. */
  bootId: string | null;
  /**
   * The turn of a checkpoint being sent when this was written: the disk had everything that
   * checkpoint carries, so the API holding it while the marker says one less is the marker
   * lagging (a stop between the API's answer and the marker's write), not a rollback.
   */
  pending?: number;
}

export interface Boot {
  id: string | null;
  at: string | null;
}

export type Recovery = {
  kind: "none" | "rebuilt" | "rollback";
  restored: { session: boolean; workspace: boolean };
};

/** What the person is told once the conversation stops being saved. */
export const SESSION_UNSAVED =
  "This conversation is now too long for Ponzu to keep a copy of it. Your files are still saved after each turn, but if this sandbox is lost Claude will start a new conversation.";

export interface CheckpointOptions {
  api: RunnerApi;
  /** Where the marker is kept: the runner's state folder. */
  stateDir: string;
  transcripts: Transcripts | null;
  work: WorkSaver | null;
  log(message: string): void;
  /** A structured line for the runner's log. */
  event(name: string, fields: Record<string, unknown>): void;
  boot(): Boot;
  /** Puts everything written on the disk (`sync`). */
  flush(): Promise<void>;
  /** Tells the person, in the thread, something they lost or may want: said once per thing. */
  notify?(message: string): void;
  /**
   * Begins a mark of the events the session holds, as its archive is about to be taken
   * (save/held.ts). Without it a checkpoint does not say, and the API counts what was delivered.
   */
  held?(): HeldMark;
  /**
   * The runner's usage totals (usage.ts), which go in the transcript's archive and come back
   * with it, so a turn reported before the disk went back is not counted again after it.
   */
  usage?: {
    /** The totals of `sessionId` as the disk has them, or null. */
    saved(sessionId: string): string | null;
    /** Puts carried totals back, never lowering the disk's. Answers whether they changed. */
    restore(data: string): boolean;
  };
}

export class Checkpoints {
  /** The highest turn marker this process knows of: the disk's or the API's. */
  private turn = 0;
  private saving: Promise<void> | null = null;
  private again: string | null | undefined = undefined;
  /** What the last checkpoint saved, so an unchanged sandbox saves nothing. */
  private last: string | null = null;
  /** The API's last checkpoint, as this process last heard of it. */
  private known: SavedPoint | null = null;
  /** What the person was already told, so it is said once. */
  private told = new Set<string>();

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
    this.known = saved;
    this.turn = Math.max(disk?.turn ?? 0, saved?.turn ?? 0);
    const restored = { session: false, workspace: false };
    if (!saved || (disk && disk.turn >= saved.turn)) return { kind: "none", restored };
    if (disk?.pending !== undefined && disk.pending >= saved.turn) {
      // The disk wrote everything of that checkpoint before it was sent; only the marker's
      // confirmation was cut off. Nothing went back.
      this.opts.event("marker_lag", {
        diskTurn: disk.turn,
        pending: disk.pending,
        savedTurn: saved.turn,
        bootId: this.opts.boot().id,
      });
      this.write(saved, this.opts.boot());
      return { kind: "none", restored };
    }
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
    this.known = latest;
    if (point.session && this.opts.transcripts) {
      try {
        const { usage } = await this.opts.transcripts.unpack(point.session);
        restored.session = true;
        if (usage && this.opts.usage) {
          const raised = this.opts.usage.restore(usage);
          this.opts.event("usage_restored", { turn: latest.turn, raised });
        }
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
        if (!work.done && work.kept)
          this.tell(
            `wip:${latest.turn}`,
            `The uncommitted work from before this sandbox was rebuilt could not go back on the branch, which has moved on since. It is on the branch ${work.kept} in the sandbox: ask Claude to bring over what you need.`,
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
    // Before anything of the session is read: what settles from here on may not be in it.
    const held = this.opts.held?.();
    try {
      await this.saveFrom(sessionId, held);
    } finally {
      held?.end();
    }
  }

  private async saveFrom(sessionId: string | null, held: HeldMark | undefined): Promise<void> {
    const { transcripts, work } = this.opts;
    const large: { path: string; size: number }[] = [];
    const skipped = (path: string, size: number) => large.push({ path, size });
    const stamp = [
      sessionId ?? "",
      sessionId && transcripts ? transcripts.stamp(sessionId, skipped) : "",
      work ? await work.stamp(skipped) : "",
    ].join("#");
    // Written in the last moments and too large to hash: told apart by size and times alone.
    if (large.length)
      this.opts.event("checkpoint_hash_skipped", {
        files: large.length,
        bytes: large.reduce((sum, file) => sum + file.size, 0),
        paths: large.slice(0, 10).map((file) => file.path),
      });
    if (stamp === this.last) return;
    const turn = this.turn + 1;
    const known = this.known;
    // Each part on its own: one that cannot be saved never keeps the other from it. What is not
    // carried, the API keeps from the checkpoint before (`keep`), so a checkpoint never carries
    // less than the last one.
    let session: Uint8Array | null = null;
    if (sessionId && transcripts) {
      try {
        session = await transcripts.pack(sessionId, this.opts.usage?.saved(sessionId));
      } catch (err) {
        this.opts.log(`the session's transcript was left out of the checkpoint: ${said(err)}`);
        this.opts.event("checkpoint_session_skipped", { turn, reason: said(err) });
        if (err instanceof TranscriptTooLarge) this.tell("session", SESSION_UNSAVED);
      }
    }
    let saved: SavedWork | null = null;
    if (work) {
      try {
        saved = await work.save(turn);
      } catch (err) {
        this.opts.log(`the work in progress was left out of the checkpoint: ${said(err)}`);
        this.opts.event("checkpoint_work_skipped", { turn, reason: said(err) });
      }
    }
    if (saved?.skipped.length)
      this.opts.log(`left out of the checkpoint: ${saved.skipped.join(", ")}`);
    const keepSession = !session && !!known?.session;
    // No checkout (it could not be had), a save that failed, or nothing new: the work saved
    // before is still the work.
    const keepWorkspace =
      !saved?.workspace && (!saved || !!saved.kept) && !!(known?.workspace || known?.wipCommit);
    // Before the call: once the API has it, this disk has everything it carries.
    this.write(this.markerPoint(), this.opts.boot(), turn);
    const point = await this.opts.api.saveCheckpoint({
      turn,
      claudeSessionId: session ? sessionId : null,
      wipCommit: saved?.wipCommit ?? (keepWorkspace ? (known?.wipCommit ?? null) : null),
      session,
      workspace: saved?.workspace ?? null,
      ...(keepSession || keepWorkspace
        ? { keep: { session: keepSession, workspace: keepWorkspace } }
        : {}),
      // Said only of a transcript this checkpoint carries; one it keeps from before, or none,
      // the API counts as it always has.
      ...(session && held ? { heldThrough: () => held.read() } : {}),
    });
    this.known = point;
    this.turn = Math.max(turn, point.turn);
    // Another process saved a later one: this one was not recorded, so the disk is not at it.
    if (point.turn !== turn) return;
    this.last = stamp;
    this.write(point, this.opts.boot());
    await this.opts.flush();
  }

  /** The marker as the disk has it now, to carry a pending turn. */
  private markerPoint(): SavedPoint {
    const disk = this.marker();
    return {
      turn: disk?.turn ?? 0,
      at: disk?.at ?? new Date(0).toISOString(),
      claudeSessionId: disk?.claudeSessionId ?? null,
      wipCommit: disk?.wipCommit ?? null,
      session: false,
      workspace: false,
    };
  }

  private tell(what: string, message: string): void {
    if (this.told.has(what)) return;
    this.told.add(what);
    this.opts.notify?.(message);
  }

  private write(point: SavedPoint, boot: Boot, pending?: number): void {
    const marker: Marker = {
      turn: point.turn,
      at: point.at,
      claudeSessionId: point.claudeSessionId,
      wipCommit: point.wipCommit,
      bootId: boot.id,
      ...(pending === undefined ? {} : { pending }),
    };
    writeDurably(this.file, JSON.stringify(marker));
  }
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
