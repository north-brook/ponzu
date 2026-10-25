import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
  type Artboard,
  boardVersion,
  type Doc,
  DRAW_VERSION,
  findArtboard,
  isThemed,
  rewriteCssUrls,
  serializeArtboardElement,
} from "@ponzu/core";
import type { LoopResult, Renderer } from "@ponzu/render";
import type { Design } from "@ponzu/store";
import { defaultCacheDir, touch, trim, unitOf } from "./cache.ts";
import { MEDIA_HEADERS } from "./renditions.ts";
import type { LocalWorkspace } from "./workspace.ts";

/*
 * Pictures and motion loops of artboards, for a canvas that draws boards
 * small, kept on disk in ~/.ponzu/cache so a design opens to pictures the
 * next time, and made in the background as soon as a design opens or a board
 * changes.
 *
 * Every file is named by a hash of what it shows: the artboard's HTML, the
 * tokens, the theme, the size and date of every asset it uses, and how this
 * version draws. A job draws the board as it is when the job starts, and files
 * it under that content's hash, so a file always shows what its name says.
 * The canvas names the version it wants (`v`, boardVersion); an answer for
 * another version is never kept under that URL.
 *
 * Work runs by priority: what the canvas asks for (it's on screen) first,
 * then boards that changed, then the open design's boards page by page.
 * Pictures before loops: a loop takes 5-90 s to film, a picture 0.1-1 s.
 */

/** Resolutions the canvas asks for, device px per CSS px (snapshot.tsx BUCKETS). */
export const PICTURE_SCALES = [0.25, 0.5, 1] as const;
/** What a design's boards get in the background: the line where they become pictures. */
const WARM_SCALE = 0.5;
/**
 * Loops are filmed at twice the scale they show at (below WARM_SCALE): H.264
 * keeps colour at half resolution, which blurs fine coloured detail by 6/255
 * on average at 1x and by 1/255 when the video is drawn at half its size.
 */
const LOOP_SCALE = 1;
const PICTURE_BYTES = 1024 ** 3;
const LOOP_BYTES = 1024 ** 3;
/** Filming a board gives up after this long: a hung film mustn't hold the loop lane. */
const FILM_DEADLINE_MS = 90_000;
/** A failed film is tried again after these waits, then not again this run. */
const FILM_RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** A picture drawn before its fonts or images arrived is served, not kept, and redrawn after this. */
const REDRAW_MS = 30_000;
/** While an agent works, background jobs wait and check again this often. */
const AGENT_POLL_MS = 500;

export type Priority = "now" | "soon" | "later";
const RANK: Record<Priority, number> = { now: 0, soon: 1, later: 2 };

export interface Picture {
  bytes: Uint8Array;
  mime: string;
  /** The board has animation that loops forever. */
  loops: boolean;
  /** The longest side, in CSS px, of its biggest looping animation, 0 when still. */
  loopSize: number;
  /** Device px per CSS px it was drawn at: the one asked for, or a bigger one already made. */
  scale: number;
  /** Which version of the board it shows (boardVersion). */
  version: string;
  /** Its content hash, for revalidation: it changes with the assets too. */
  hash: string;
  /** Drawn before its fonts or images arrived: not for keeping. */
  partial?: boolean;
}

/** A board's loops, or none, and which version of the board they're for. */
export interface Loops {
  manifest: LoopManifest | null;
  version: string;
  hash: string;
  /** Filming failed for now: asked again, it may succeed. */
  retry?: boolean;
}

export interface LoopManifest {
  /** Video time v shows the board's timeline at t0 + v (+ any whole number of periods). */
  t0: number;
  regions: {
    x: number;
    y: number;
    width: number;
    height: number;
    period: number;
    /** The video, under /api/loop. */
    src: string;
    /** Data ids of the nodes it animates: live animations on them follow the video at handoff. */
    ids: string[];
  }[];
  /** Animated areas left still (too long a cycle to film), in the board's CSS px. */
  still: { x: number; y: number; width: number; height: number }[];
}

interface Meta {
  loops: boolean;
  /** The longest side, in CSS px, of its biggest looping animation (render's MotionInfo). */
  loopSize?: number;
}

interface Job {
  id: string;
  rank: number;
  lane: "picture" | "loop";
  run: () => Promise<unknown>;
  done: Promise<unknown>;
  resolve: (v: unknown) => void;
}

export interface PicturesOptions {
  /** Cache folder. Default ~/.ponzu/cache. */
  dir?: string;
  /**
   * Whether an agent is working now. Its screenshots share the renderer, so
   * background jobs don't start meanwhile, and only one of the canvas's runs.
   */
  agentBusy?: () => boolean;
  /** How long a film may take before it's given up on. Default 90 s. */
  filmDeadlineMs?: number;
}

/** Which board content a job drew. */
interface Drawn {
  hash: string;
  version: string;
}

/** A board as a job draws it: copied when the job starts, so edits after can't change it. */
interface Snapshot {
  ab: Artboard;
  tokens: string;
  scheme: "light" | "dark";
  hash: string;
  version: string;
}

export class Pictures {
  readonly pictureDir: string;
  readonly loopDir: string;
  private queue: Job[] = [];
  private jobs = new Map<string, Job>();
  private running = { picture: 0, loop: 0 };
  private readonly max = {
    picture: Math.max(2, Math.min(4, Math.floor(availableParallelism() / 4))),
    loop: 1,
  };
  private written = { picture: 0, loop: 0 };
  private warmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Pictures drawn before their assets arrived, held briefly in memory instead of on disk. */
  private partial = new Map<string, { pic: Picture; until: number }>();
  /** Films that failed, by content hash: how many times, and not before when. */
  private filmFailures = new Map<string, { n: number; next: number }>();
  private agentBusy: () => boolean;
  private filmDeadlineMs: number;
  private agentTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private ws: LocalWorkspace,
    opts: PicturesOptions = {},
  ) {
    const dir = opts.dir ?? defaultCacheDir();
    this.pictureDir = join(dir, "pictures");
    this.loopDir = join(dir, "loops");
    this.agentBusy = opts.agentBusy ?? (() => false);
    this.filmDeadlineMs = opts.filmDeadlineMs ?? FILM_DEADLINE_MS;
  }

  /** The folders and their budgets, for trimming. */
  budgets(): { dir: string; max: number }[] {
    return [
      { dir: this.pictureDir, max: PICTURE_BYTES },
      { dir: this.loopDir, max: LOOP_BYTES },
    ];
  }

  /** Designs watched for edits, by key: the design object and how to stop watching it. */
  private watching = new Map<string, { design: Design; stop: () => void }>();

  /**
   * A canvas opened this design: make every board's picture in the
   * background (the canvas asks for the ones on screen first), and redraw
   * boards as they change. A design closed and opened again is watched afresh.
   */
  opened(key: string) {
    const design = this.ws.get(key);
    if (!design) return;
    const known = this.watching.get(key);
    if (known?.design === design) return;
    known?.stop();
    this.warm(key);
    const offOp = design.onOp((e) => {
      if (!e.artboards.length) return;
      // Once edits settle: an agent writing a board sends many ops.
      for (const id of e.artboards) {
        const t = `${key}\n${id}`;
        clearTimeout(this.warmTimers.get(t));
        this.warmTimers.set(
          t,
          setTimeout(() => {
            this.warmTimers.delete(t);
            void this.warmBoard(key, id, "soon");
          }, 1500),
        );
      }
    });
    const offReset = design.onReset(() => this.warm(key));
    this.watching.set(key, {
      design,
      stop: () => {
        offOp();
        offReset();
      },
    });
  }

  /** Every board of a design, its first page first, at the background priority. */
  warm(key: string) {
    const doc = this.ws.get(key)?.doc;
    if (!this.ws.renderer || !doc) return;
    for (const page of doc.pages)
      for (const ab of page.artboards) void this.warmBoard(key, ab.id, "later");
  }

  /** A board's loops again, in the background, after a failed film's wait. */
  private async warmLoops(key: string, artboardId: string, theme?: "light" | "dark") {
    await this.loops(key, artboardId, { wait: false, priority: "later", theme });
  }

  private async warmBoard(key: string, artboardId: string, priority: Priority) {
    const pic = await this.picture(key, artboardId, WARM_SCALE, { wait: true, priority });
    if (pic && pic !== "pending" && pic.loops)
      await this.loops(key, artboardId, { wait: true, priority });
  }

  /** The board now: the theme it's drawn in, its content hash and its version. */
  private async board(key: string, artboardId: string, theme?: "light" | "dark") {
    const doc: Doc | undefined = this.ws.get(key)?.doc;
    const ab = doc && findArtboard(doc, artboardId)?.artboard;
    if (!doc || !ab) return null;
    const scheme = isThemed(doc.tokens, ab.root) ? (theme ?? this.ws.theme ?? "light") : "light";
    const { html, assets } = boardHtml(ab, doc.tokens);
    const version = boardVersion(html, doc.tokens);
    // Asked afresh each time: an asset replaced on disk changes no op, and a stat is cheap.
    const hash = await contentHash(html, doc.tokens, scheme, key, assets);
    return { key, artboardId, theme, scheme, version, hash };
  }

  /**
   * The board as a job starting now draws it: a copy, so an edit (or an undo)
   * while it draws can't put one version's pixels under another's name.
   */
  private async snapshot(key: string, artboardId: string, theme?: "light" | "dark") {
    const doc: Doc | undefined = this.ws.get(key)?.doc;
    const live = doc && findArtboard(doc, artboardId)?.artboard;
    if (!doc || !live) return null;
    const ab = structuredClone(live);
    const tokens = doc.tokens;
    const scheme = isThemed(tokens, ab.root) ? (theme ?? this.ws.theme ?? "light") : "light";
    const { html, assets } = boardHtml(ab, tokens);
    const snap: Snapshot = {
      ab,
      tokens,
      scheme,
      version: boardVersion(html, tokens),
      hash: await contentHash(html, tokens, scheme, key, assets),
    };
    return snap;
  }

  /**
   * A picture of a board at `scale`, or a bigger one already made. Without
   * `wait`, "pending" when there's none yet: it's made in the background,
   * at `priority`, for the next ask.
   */
  async picture(
    key: string,
    artboardId: string,
    scale: number,
    opts: { wait: boolean; priority: Priority; theme?: "light" | "dark" },
  ): Promise<Picture | "pending" | null> {
    const renderer = this.ws.renderer;
    const b = await this.board(key, artboardId, opts.theme);
    if (!renderer || !b) return null;
    const want = PICTURE_SCALES.find((s) => s >= scale) ?? PICTURE_SCALES.at(-1)!;
    const have = await this.bestPicture(b.hash, b.version, want);
    if (have) {
      // A bigger one serves now; the right size comes later, if it's asked for again.
      if (have.scale !== want) this.enqueuePicture(b, want, renderer, "later");
      return have;
    }
    const job = this.enqueuePicture(b, want, renderer, opts.priority);
    if (!opts.wait) return "pending";
    // What the job drew: the board as it was when it started, which may be newer than asked.
    const drawn = (await job) as Drawn | undefined;
    return drawn ? this.bestPicture(drawn.hash, drawn.version, want) : null;
  }

  /** The picture at `want` or the smallest bigger one, on disk or held in memory. */
  private async bestPicture(hash: string, version: string, want: number) {
    for (const s of PICTURE_SCALES) {
      if (s < want) continue;
      const held = this.partial.get(`${hash}:${s}`);
      if (held && held.until > Date.now()) return held.pic;
      const hit = await this.readPicture(hash, version, s);
      if (hit) return hit;
    }
    return null;
  }

  private enqueuePicture(
    b: NonNullable<Awaited<ReturnType<Pictures["board"]>>>,
    scale: number,
    renderer: Renderer,
    priority: Priority,
  ) {
    return this.enqueue(`p:${b.hash}:${scale}`, "picture", priority, async () => {
      const snap = await this.snapshot(b.key, b.artboardId, b.theme);
      if (!snap) return;
      const drawn: Drawn = { hash: snap.hash, version: snap.version };
      if (await exists(this.picturePath(snap.hash, scale))) return drawn;
      const out = await renderer.render({
        artboard: snap.ab,
        tokens: snap.tokens,
        scale,
        format: "jpeg",
        colorScheme: snap.scheme,
        assetBase: this.ws.assetBase(b.key),
        // Image renditions instead of originals, where the renderer has them (thumbnail renders).
        ...THUMBNAIL,
      });
      if (!out.bytes.length) return;
      const meta: Meta = { loops: Boolean(out.motion?.loops), loopSize: out.motion?.loopSize ?? 0 };
      if (out.assetsTimedOut) {
        // Fonts or images still loading: show it a while, keep nothing, draw it again later.
        const pic: Picture = {
          bytes: out.bytes,
          mime: "image/jpeg",
          ...meta,
          loopSize: meta.loopSize ?? 0,
          scale,
          version: snap.version,
          hash: snap.hash,
          partial: true,
        };
        const id = `${snap.hash}:${scale}`;
        this.partial.set(id, { pic, until: Date.now() + REDRAW_MS });
        const t = setTimeout(() => {
          this.partial.delete(id);
          void this.picture(b.key, b.artboardId, scale, {
            wait: false,
            priority: "later",
            theme: b.theme,
          });
        }, REDRAW_MS);
        t.unref?.();
        return drawn;
      }
      await this.write(this.pictureDir, `${snap.hash}.json`, JSON.stringify(meta));
      await this.write(this.pictureDir, `${snap.hash}-${scale}.jpg`, out.bytes, "picture");
      return drawn;
    });
  }

  private picturePath(hash: string, scale: number) {
    return join(this.pictureDir, `${hash}-${scale}.jpg`);
  }

  private async readPicture(hash: string, version: string, scale: number): Promise<Picture | null> {
    const file = this.picturePath(hash, scale);
    const metaFile = join(this.pictureDir, `${hash}.json`);
    const [bytes, meta] = await Promise.all([
      readFile(file).catch(() => null),
      readFile(metaFile, "utf8")
        .then((s) => JSON.parse(s) as Meta)
        .catch(() => null),
    ]);
    // Kept together or not at all: a picture without its metadata is drawn again.
    if (!bytes || !meta) return null;
    void touch(file, metaFile);
    return {
      bytes: new Uint8Array(bytes),
      mime: "image/jpeg",
      loops: meta.loops,
      loopSize: meta.loopSize ?? 0,
      scale,
      version,
      hash,
    };
  }

  /**
   * A board's motion loops: where each video goes and its URL. Null when the
   * board doesn't loop or this renderer can't film; "pending" while filming.
   */
  async loops(
    key: string,
    artboardId: string,
    opts: { wait: boolean; priority: Priority; theme?: "light" | "dark" },
  ): Promise<Loops | "pending" | null> {
    const renderer = this.ws.renderer;
    const b = await this.board(key, artboardId, opts.theme);
    if (!renderer?.loop || !b) return null;
    const found = (hash: string, version: string, manifest: LoopManifest | null): Loops => ({
      manifest,
      version,
      hash,
    });
    const hit = await this.readLoops(b.hash);
    if (hit !== undefined) return found(b.hash, b.version, hit);
    // A board whose picture says it doesn't loop isn't filmed.
    const meta = await readFile(join(this.pictureDir, `${b.hash}.json`), "utf8")
      .then((t) => JSON.parse(t) as Meta)
      .catch(() => null);
    if (meta && !meta.loops) return found(b.hash, b.version, null);
    const failed = this.filmFailures.get(b.hash);
    if (failed && (failed.n > FILM_RETRY_MS.length || failed.next > Date.now()))
      return { ...found(b.hash, b.version, null), retry: true };
    const job = this.enqueue(`l:${b.hash}`, "loop", opts.priority, async () => {
      const snap = await this.snapshot(b.key, b.artboardId, b.theme);
      if (!snap) return;
      const drawn: Drawn = { hash: snap.hash, version: snap.version };
      if ((await this.readLoops(snap.hash)) !== undefined) return drawn;
      let out: LoopResult | null;
      // Past the deadline the film is given up on, and told so: its page closes.
      const stop = new AbortController();
      try {
        out = await deadline(
          renderer.loop!({
            artboard: snap.ab,
            tokens: snap.tokens,
            scale: LOOP_SCALE,
            colorScheme: snap.scheme,
            assetBase: this.ws.assetBase(key),
            signal: stop.signal,
            ...THUMBNAIL,
          }),
          this.filmDeadlineMs,
        );
      } catch {
        stop.abort();
        out = null;
      }
      // A crash, a hang, or filmed before its fonts or images came: nothing kept, tried again
      // later, a few times.
      if (!out || out.assetsTimedOut) {
        const n = (this.filmFailures.get(snap.hash)?.n ?? 0) + 1;
        const wait = FILM_RETRY_MS[n - 1];
        this.filmFailures.set(snap.hash, { n, next: Date.now() + (wait ?? Infinity) });
        // The canvas asks again while it shows the board; the background tries once more too.
        if (wait !== undefined) {
          const t = setTimeout(() => void this.warmLoops(b.key, b.artboardId, b.theme), wait);
          t.unref?.();
        }
        return drawn;
      }
      this.filmFailures.delete(snap.hash);
      const regions: LoopManifest["regions"] = [];
      for (const [i, r] of out.regions.entries()) {
        const name = `${snap.hash}-${i}.mp4`;
        await this.write(this.loopDir, name, r.bytes, "loop");
        regions.push({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          period: r.period,
          src: `/api/loop?id=${name}`,
          ids: r.ids,
        });
      }
      const still = out.still.map(({ x, y, width, height }) => ({ x, y, width, height }));
      // Filmed, and nothing could be: null says so for good.
      const m: LoopManifest | null = regions.length ? { t0: out.t0, regions, still } : null;
      await this.write(this.loopDir, `${snap.hash}.json`, JSON.stringify(m));
      return drawn;
    });
    if (!opts.wait) return "pending";
    const drawn = (await job) as Drawn | undefined;
    if (!drawn) return null;
    const after = await this.readLoops(drawn.hash);
    if (after !== undefined) return found(drawn.hash, drawn.version, after);
    return { ...found(drawn.hash, drawn.version, null), retry: true };
  }

  /**
   * A board's manifest on disk: undefined when there's none, or when a video
   * it names is gone (trimmed): then it's filmed again.
   */
  private async readLoops(hash: string): Promise<LoopManifest | null | undefined> {
    const file = join(this.loopDir, `${hash}.json`);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text === null) return undefined;
    const m = JSON.parse(text) as LoopManifest | null;
    const videos = (m?.regions ?? []).map((r) =>
      join(this.loopDir, new URL(r.src, "http://x").searchParams.get("id") ?? ""),
    );
    if (!(await Promise.all(videos.map(exists))).every(Boolean)) return undefined;
    void touch(file, ...videos);
    return m;
  }

  /** A loop video by file name, as named in a manifest. */
  async video(name: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{40}-\d+\.mp4$/.test(name)) return null;
    const file = join(this.loopDir, name);
    const bytes = await readFile(file).catch(() => null);
    if (bytes) void touch(file, join(this.loopDir, `${unitOf(name)}.json`));
    return bytes && new Uint8Array(bytes);
  }

  /* The queue: one per lane, best priority first, each job once. */

  private enqueue(id: string, lane: Job["lane"], priority: Priority, run: () => Promise<unknown>) {
    const rank = RANK[priority];
    const known = this.jobs.get(id);
    if (known) {
      // Asked for again, sooner: move it up.
      if (rank < known.rank) {
        known.rank = rank;
        this.sort();
      }
      return known.done;
    }
    let resolve!: (v: unknown) => void;
    const done = new Promise<unknown>((r) => {
      resolve = r;
    });
    const job: Job = { id, rank, lane, run, done, resolve };
    this.jobs.set(id, job);
    this.queue.push(job);
    this.sort();
    this.pump();
    return done;
  }

  private sort() {
    // Stable: same priority keeps arrival order, so a page warms top to bottom.
    this.queue.sort((a, b) => a.rank - b.rank);
  }

  private pump() {
    // An agent's screenshot shares the renderer: while it works, nothing in the
    // background starts, and the canvas's own asks go one at a time.
    const busy = this.agentBusy();
    let held = false;
    for (const lane of ["picture", "loop"] as const) {
      while (this.running[lane] < (busy ? 1 : this.max[lane])) {
        if (busy && this.running.picture + this.running.loop > 0) {
          held ||= this.queue.length > 0;
          break;
        }
        const i = this.queue.findIndex((j) => j.lane === lane && (!busy || j.rank === RANK.now));
        if (i < 0) {
          held ||= busy && this.queue.some((j) => j.lane === lane);
          break;
        }
        const job = this.queue.splice(i, 1)[0]!;
        this.running[lane]++;
        void job
          .run()
          .catch(() => undefined)
          .then((v) => {
            this.running[lane]--;
            this.jobs.delete(job.id);
            job.resolve(v);
            this.pump();
          });
      }
    }
    if (held && !this.agentTimer) {
      this.agentTimer = setTimeout(() => {
        this.agentTimer = undefined;
        this.pump();
      }, AGENT_POLL_MS);
      this.agentTimer.unref?.();
    }
  }

  /** Write then rename, so a reader never sees half a file; trim the folder now and then. */
  private async write(
    dir: string,
    name: string,
    data: Uint8Array | string,
    budget?: "picture" | "loop",
  ) {
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
    if (!budget) return;
    this.written[budget] += data.length;
    if (this.written[budget] > 64 * 1024 ** 2) {
      this.written[budget] = 0;
      void trim(dir, budget === "picture" ? PICTURE_BYTES : LOOP_BYTES);
    }
  }
}

/** Ask for image renditions; renderers without the flag ignore it. */
const THUMBNAIL = { thumbnail: true } as const;

/**
 * A board's HTML, and the design assets it and the tokens use: every URL the
 * serializer sees (attributes, srcset candidates, url() and image-set() in
 * styles), as written, not fished out of the markup.
 */
export function boardHtml(ab: Artboard, tokens: string): { html: string; assets: Set<string> } {
  const assets = new Set<string>();
  const note = (u: string) => {
    const a = assetPath(u);
    if (a) assets.add(a);
    return u;
  };
  const html = serializeArtboardElement(ab, { rewriteUrl: note });
  rewriteCssUrls(tokens, note);
  // What rewriteUrl saw is the URL as written; the markup is the same with it unchanged.
  return { html, assets };
}

/** A design asset's path (`assets/...`), from a URL as a design writes it; null for any other. */
export function assetPath(url: string): string | null {
  const u = url
    .trim()
    .replace(/^\.\//, "")
    .replace(/[?#].*$/, "");
  return u.startsWith("assets/") && !u.includes("..") ? u : null;
}

/**
 * What a picture of a board depends on: its HTML, the tokens, the theme, the
 * assets it uses (by size and date), and how this version draws.
 */
export async function contentHash(
  html: string,
  tokens: string,
  scheme: string,
  key: string,
  assets: Iterable<string>,
): Promise<string> {
  const h = createHash("sha1");
  h.update(`${DRAW_VERSION}\0${scheme}\0${tokens}\0${html}`);
  for (const a of [...new Set(assets)].sort()) {
    const s = await stat(join(key, decodedPath(a))).catch(() => null);
    h.update(`\0${a}:${s ? `${s.size}:${Math.floor(s.mtimeMs)}` : "-"}`);
  }
  return h.digest("hex");
}

/** A URL path as a file path; one that isn't valid percent-encoding (a bare %) as it is. */
function decodedPath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** `work`, or a rejection once `ms` have passed. */
function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`gave up after ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function exists(p: string) {
  return Boolean(await stat(p).catch(() => null));
}

/**
 * The canvas's routes. `wait=0` answers at once: 202 when the picture or
 * loops are still being made (made next, since the canvas is showing them),
 * so the canvas can show something else meanwhile and ask again later.
 * Without `wait=0` the answer waits until they're done.
 *   GET /api/snapshot?file&artboard&scale&v&wait  -> JPEG, x-pz-loops: 1 when the board loops
 *   GET /api/loops?file&artboard&v&wait            -> LoopManifest JSON, 204 when it has none,
 *                                                     202 while filming failed for now (ask later)
 *   GET /api/loop?id                               -> a loop video (MP4)
 *
 * `v` names the version the canvas wants (boardVersion); `x-pz-version` says
 * which one this is. Only an answer for the version asked for may be kept,
 * and then only until its content hash (the etag, which covers its assets
 * too) changes: `no-cache`, so a revalidation is a cheap 304. Anything else
 * is `no-store`. Loop videos are named by their content hash: immutable.
 */
export async function pictureRoute(
  pictures: Pictures,
  path: string,
  url: URL,
  allowed: (key: string) => Promise<boolean>,
  range?: string | null,
  ifNoneMatch?: string | null,
): Promise<Response | null> {
  if (path !== "/api/snapshot" && path !== "/api/loops" && path !== "/api/loop") return null;
  if (path === "/api/loop") {
    const bytes = await pictures.video(url.searchParams.get("id") ?? "");
    if (!bytes) return new Response("Not found", { status: 404, headers: MEDIA_HEADERS });
    return rangeResponse(bytes, range, {
      "content-type": "video/mp4",
      "cache-control": "private, max-age=31536000, immutable",
      ...MEDIA_HEADERS,
    });
  }
  const key = url.searchParams.get("file");
  const artboard = url.searchParams.get("artboard");
  if (!key || !artboard) return new Response("file and artboard required", { status: 400 });
  if (!(await allowed(key))) return new Response("Not found", { status: 404 });
  const wait = url.searchParams.get("wait") !== "0";
  const asked = url.searchParams.get("v");
  // A canvas asks for what it shows: ahead of the background's work.
  const priority: Priority = "now";
  const t = url.searchParams.get("scheme");
  const theme = t === "dark" || t === "light" ? t : undefined;
  const noStore = { "cache-control": "no-store", ...MEDIA_HEADERS };
  const pending = () => new Response(null, { status: 202, headers: noStore });
  /** Cache headers for an answer showing `version` with content `hash`. */
  const caching = (version: string, hash: string, keep: boolean) => {
    const etag = `"${hash}"`;
    const ok = keep && asked === version;
    return {
      ok,
      etag,
      headers: {
        ...(ok ? { "cache-control": "private, no-cache", etag } : noStore),
        ...MEDIA_HEADERS,
        "x-pz-version": version,
      },
    };
  };
  if (path === "/api/loops") {
    const m = await pictures.loops(key, artboard, { wait, priority, theme });
    // Filming failed for now: like "being made", so the canvas asks again later.
    if (m === "pending" || m?.retry) return pending();
    if (!m) return new Response(null, { status: 204, headers: noStore });
    const c = caching(m.version, m.hash, !m.retry);
    const headers = { ...c.headers, "access-control-expose-headers": "x-pz-version" };
    if (c.ok && ifNoneMatch === c.etag) return new Response(null, { status: 304, headers });
    if (!m.manifest) return new Response(null, { status: 204, headers });
    return Response.json(m.manifest, { headers });
  }
  const scale = Number(url.searchParams.get("scale"));
  if (!(scale > 0 && scale <= 4)) return new Response("scale required", { status: 400 });
  const pic = await pictures.picture(key, artboard, scale, { wait, priority, theme });
  if (pic === "pending") return pending();
  if (!pic) return new Response("Not found", { status: 404, headers: noStore });
  // A bigger picture standing in for the one asked for isn't that URL's to keep, nor one
  // drawn before its fonts and images came.
  const exact = pic.scale === (PICTURE_SCALES.find((s) => s >= scale) ?? pic.scale);
  const c = caching(pic.version, `${pic.hash}-${pic.scale}`, exact && !pic.partial);
  const headers = {
    ...c.headers,
    "content-type": pic.mime,
    "x-pz-loops": pic.loops ? "1" : "0",
    "x-pz-loop-size": String(pic.loopSize),
    "x-pz-scale": String(pic.scale),
    // Drawn before its fonts or images came: show it, and ask again in a while.
    ...(pic.partial ? { "x-pz-partial": "1" } : {}),
    "access-control-expose-headers":
      "x-pz-loops, x-pz-loop-size, x-pz-scale, x-pz-version, x-pz-partial",
  };
  if (c.ok && ifNoneMatch === c.etag) return new Response(null, { status: 304, headers });
  return new Response(pic.bytes as BodyInit, { headers });
}

/**
 * Bytes, or the part a Range header asks for. Chrome seeks a <video> only
 * when its server answers ranges: without them, setting currentTime plays
 * from the start again, and a handoff can't line the video up.
 */
export function rangeResponse(
  bytes: Uint8Array,
  range: string | null | undefined,
  headers: Record<string, string>,
): Response {
  const all = { ...headers, "accept-ranges": "bytes" };
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (!m || (!m[1] && !m[2])) return new Response(bytes as BodyInit, { headers: all });
  const size = bytes.length;
  const start = Math.max(0, m[1] ? Number(m[1]) : size - Number(m[2]));
  const end = Math.min(size - 1, m[1] && m[2] ? Number(m[2]) : size - 1);
  if (start > end)
    return new Response(null, {
      status: 416,
      headers: { ...all, "content-range": `bytes */${size}` },
    });
  return new Response(bytes.subarray(start, end + 1) as BodyInit, {
    status: 206,
    headers: { ...all, "content-range": `bytes ${start}-${end}/${size}` },
  });
}
