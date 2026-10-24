import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkpointLine,
  compactionPoint,
  compactJournal,
  type Doc,
  intentLine,
  JOURNAL_FILE,
  JOURNAL_LIMIT,
  type JournalEntry,
  type JournalOrigin,
  latestDoc,
  opLine,
  parseJournal,
} from "@ponzu/core";
import type { Design } from "@ponzu/store";

export { JOURNAL_FILE } from "@ponzu/core";

/**
 * Keeps a design's `.ponzu/journal.ndjson`: every op the design applies, with
 * when and who. Appends run one at a time, in order. A journal that grows past
 * the limit is rewritten to its newer half, starting with a checkpoint.
 */
export class JournalWriter {
  private queue: Promise<void> = Promise.resolve();
  private bytes = 0;
  private closed = false;
  readonly path: string;

  constructor(
    readonly root: string,
    private opts: { limit?: number; now?: () => number } = {},
  ) {
    this.path = join(root, JOURNAL_FILE);
  }

  private get now() {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Start keeping the journal for `design`. Writes a checkpoint when there's
   * no journal yet, or when replaying it doesn't come out as the doc on disk
   * (the folder was edited while nothing was watching). Returns a stop function.
   */
  start(design: Design, clientOf?: (origin: JournalOrigin) => string | undefined): () => void {
    // The doc as it opened: ops applied before the read below finishes follow it.
    const opened = structuredClone(design.doc);
    const at = this.now;
    this.run(async () => {
      await this.ensureFolder();
      const text = await readFile(this.path, "utf8").catch(() => "");
      this.bytes = Buffer.byteLength(text);
      const replayed = text ? latestDoc(parseJournal(text)) : null;
      if (!replayed || !sameDoc(replayed, opened)) await this.append(checkpointLine(opened, at));
    });
    const offOp = design.onOp((e) => {
      const origin: JournalOrigin = { ...e.origin };
      const client = clientOf?.(origin);
      if (client) origin.client = client;
      const line = opLine(e.op, origin, e.artboards, this.now);
      this.run(() => this.append(line));
    });
    const offReset = design.onReset((doc) => {
      const line = checkpointLine(doc, this.now);
      this.run(() => this.append(line));
    });
    return () => {
      offOp();
      offReset();
    };
  }

  /** What the person asked for, in a line an agent distilled. */
  intent(text: string, origin: JournalOrigin) {
    const line = intentLine(text, origin, this.now);
    this.run(() => this.append(line));
  }

  /** Everything written so far is on disk. */
  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private run(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((err) => {
      console.error("[ponzu] journal write failed:", err);
    });
  }

  private async append(line: string) {
    if (this.closed) return;
    await appendFile(this.path, line, "utf8");
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > (this.opts.limit ?? JOURNAL_LIMIT)) await this.compact();
  }

  private async compact() {
    const text = await readFile(this.path, "utf8");
    const lines = text.split("\n").filter(Boolean);
    const entries: JournalEntry[] = [];
    const sizes: number[] = [];
    for (const l of lines) {
      const parsed = parseJournal(l);
      if (!parsed[0]) continue;
      entries.push(parsed[0]);
      sizes.push(Buffer.byteLength(l) + 1);
    }
    const limit = this.opts.limit ?? JOURNAL_LIMIT;
    const at = compactionPoint(entries, sizes, limit / 2);
    const next = compactJournal(entries, at);
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, next, "utf8");
    await rename(tmp, this.path);
    this.bytes = Buffer.byteLength(next);
  }

  /** `.ponzu/` ignores itself in git; whatever else it keeps, the journal stays out. */
  private async ensureFolder() {
    const dir = join(this.root, ".ponzu");
    await mkdir(dir, { recursive: true });
    const ignore = join(dir, ".gitignore");
    const current = await readFile(ignore, "utf8").catch(() => null);
    if (current === null) await writeFile(ignore, "*\n");
    else if (!ignoresJournal(current))
      await writeFile(ignore, `${current.replace(/\n?$/, "\n")}journal.ndjson\n`);
  }
}

/** Whether a `.ponzu/.gitignore` keeps the journal out of git. */
export function ignoresJournal(gitignore: string): boolean {
  let ignored = false;
  for (const raw of gitignore.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    if (
      pattern === "*" ||
      pattern === "journal.ndjson" ||
      pattern === "*.ndjson" ||
      pattern === "/journal.ndjson"
    )
      ignored = !negated;
  }
  return ignored;
}

function sameDoc(a: Doc, b: Doc): boolean {
  const norm = (d: Doc) => {
    const { example: _e, ...rest } = d;
    return JSON.stringify(rest);
  };
  return norm(a) === norm(b);
}

/** Read a design's journal, if it has one. */
export async function readJournal(root: string): Promise<JournalEntry[]> {
  const text = await readFile(join(root, JOURNAL_FILE), "utf8").catch(() => "");
  return parseJournal(text);
}

export async function journalSize(root: string): Promise<number> {
  return stat(join(root, JOURNAL_FILE)).then(
    (s) => s.size,
    () => 0,
  );
}
