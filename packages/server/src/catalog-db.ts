import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** The schema this build writes. */
export const SCHEMA = 1;
/**
 * The oldest schema whose builds can still use a database at SCHEMA. Raise it
 * only with a migration older builds would misread; they open the database
 * read-only from then on.
 */
const MIN_READER = 1;

/**
 * Migrations, in order: MIGRATIONS[n] takes a database from schema n to n + 1.
 * Every Ponzu on the Mac shares one database, the desktop app's server, a
 * `ponzu serve` in a checkout, older and newer builds alike, so migrations only
 * add: new tables and nullable columns, never a rename or a drop.
 */
const MIGRATIONS = [
  `CREATE TABLE designs (
    path TEXT PRIMARY KEY,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    found_by TEXT,
    missing_since INTEGER,
    archived_at INTEGER,
    revived_at INTEGER,
    opened_at INTEGER,
    shelf TEXT
  );
  CREATE TABLE grants (folder TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`,
];

/** How a design came to be known. */
export type FoundBy = "spotlight" | "walk" | "opened" | "created";

/** The person's override of where a design is listed. */
export type Shelf = "recent" | "scratch";

export interface DesignRow {
  path: string;
  first_seen: number;
  last_seen: number;
  found_by: FoundBy | null;
  /** When it was first found gone; null while it's there. */
  missing_since: number | null;
  archived_at: number | null;
  /** When it was last opened by the person, restored, or edited by an agent. */
  revived_at: number | null;
  /** When the person opened it themselves, which lists an example. */
  opened_at: number | null;
  shelf: Shelf | null;
}

/** Archived until it's opened, restored or edited again. */
export function archivedAt(row: DesignRow | undefined): number | null {
  if (!row?.archived_at || row.archived_at <= (row.revived_at ?? 0)) return null;
  return row.archived_at;
}

/**
 * The catalog's memory, in ~/.ponzu/ponzu.db: every design Ponzu has found,
 * and what the person did with them (archived, shelved, examples opened, the
 * guarded folders they let Ponzu read). What a design holds stays on disk.
 *
 * Several processes write it at once, so every write is one statement that
 * sets only its own event's column. Archiving sets `archived_at`, and opening,
 * restoring or an agent's edit sets `revived_at` past it. Whichever is written
 * last wins.
 *
 * It never takes the server down: a database it can't open or read is moved
 * aside and started over, and failing that, kept in memory for this run.
 */
export class CatalogDb {
  /** A newer Ponzu changed the schema past what this build understands: reads only. */
  readonly readOnly: boolean;
  private db: Database;
  private own = 0;

  constructor(path?: string) {
    const opened = open(path);
    this.db = opened.db;
    this.readOnly = opened.readOnly;
  }

  /**
   * Changes whenever another connection, another Ponzu process, commits. Cheap:
   * read it on every listing, and the rows only when it moved. This
   * connection's own writes don't move it, so `own` counts those.
   */
  dataVersion(): number {
    return this.read(
      () =>
        (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version *
          1_000_000 +
        this.own,
      -1,
    );
  }

  all(): DesignRow[] {
    return this.read(() => this.db.query("SELECT * FROM designs").all() as DesignRow[], []);
  }

  get(path: string): DesignRow | undefined {
    return this.read(
      () =>
        (this.db.query("SELECT * FROM designs WHERE path = ?").get(path) as DesignRow | null) ??
        undefined,
      undefined,
    );
  }

  /** Designs found at `at`: known from now on, and there. */
  seen(found: Iterable<[path: string, by: FoundBy]>, at = Date.now()): void {
    this.write(() => {
      const upsert = this.db.query(
        `INSERT INTO designs (path, first_seen, last_seen, found_by) VALUES (?1, ?2, ?2, ?3)
         ON CONFLICT (path) DO UPDATE SET last_seen = ?2, missing_since = NULL`,
      );
      this.db.transaction(() => {
        for (const [path, by] of found) upsert.run(path, at, by);
      })();
    });
  }

  /** Designs whose folder is gone. They're hidden, and forgotten after a while. */
  missing(paths: Iterable<string>, at = Date.now()): void {
    this.write(() => {
      const mark = this.db.query(
        "UPDATE designs SET missing_since = ?2 WHERE path = ?1 AND missing_since IS NULL",
      );
      this.db.transaction(() => {
        for (const path of paths) mark.run(path, at);
      })();
    });
  }

  /** Forget designs that have been gone since before `before`. */
  forget(before: number): void {
    this.write(() => this.db.query("DELETE FROM designs WHERE missing_since < ?").run(before));
  }

  /** Put away until it's opened, restored or edited again. */
  archive(path: string, at = Date.now()): void {
    this.stamp(path, "archived_at", "revived_at", at);
  }

  /** Opened, restored or edited: out of the archive, if it was in it. */
  revive(path: string, at = Date.now()): void {
    this.stamp(path, "revived_at", "archived_at", at);
  }

  /** The person opened it themselves: an example stays listed from now on. */
  opened(path: string, at = Date.now()): void {
    this.set(path, "opened_at", at, at);
  }

  /** List it under Recent or Scratch whatever its file says, or (null) as its file says. */
  shelve(path: string, shelf: Shelf | null, at = Date.now()): void {
    this.set(path, "shelf", shelf, at);
  }

  grants(): string[] {
    return this.read(
      () =>
        (this.db.query("SELECT folder FROM grants").all() as { folder: string }[]).map(
          (r) => r.folder,
        ),
      [],
    );
  }

  grant(folder: string, at = Date.now()): void {
    this.write(() =>
      this.db
        .query("INSERT INTO grants (folder, at) VALUES (?, ?) ON CONFLICT (folder) DO NOTHING")
        .run(folder, at),
    );
  }

  meta(key: string): string | undefined {
    return this.read(() => {
      const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
        value: string;
      } | null;
      return row?.value ?? undefined;
    }, undefined);
  }

  setMeta(key: string, value: string): void {
    this.write(() =>
      this.db
        .query(
          "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2",
        )
        .run(key, value),
    );
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }

  /**
   * Archive or revive, in one statement, past whatever the other is already:
   * the one written last wins, even stamped in the same millisecond or by a
   * clock that's behind.
   */
  private stamp(
    path: string,
    column: "archived_at" | "revived_at",
    other: "archived_at" | "revived_at",
    at: number,
  ): void {
    this.write(() =>
      this.db
        .query(
          `INSERT INTO designs (path, first_seen, last_seen, found_by, ${column}) VALUES (?1, ?2, ?2, 'opened', ?2)
           ON CONFLICT (path) DO UPDATE SET ${column} = max(?2, coalesce(${other}, 0) + 1)`,
        )
        .run(path, at),
    );
  }

  /** One column of one design, inserting the design if it's new. */
  private set(
    path: string,
    column: "opened_at" | "shelf",
    value: number | string | null,
    at: number,
  ): void {
    this.write(() =>
      this.db
        .query(
          `INSERT INTO designs (path, first_seen, last_seen, found_by, ${column}) VALUES (?1, ?2, ?2, 'opened', ?3)
           ON CONFLICT (path) DO UPDATE SET ${column} = ?3`,
        )
        .run(path, at, value),
    );
  }

  private read<T>(run: () => T, fallback: T): T {
    try {
      return run();
    } catch {
      return fallback;
    }
  }

  private write(run: () => unknown): void {
    if (this.readOnly) return;
    try {
      run();
      this.own++;
    } catch {
      // Busy past the timeout, or the disk is full: what it would have remembered is lost,
      // and the next write tries again.
    }
  }
}

function open(path: string | undefined): { db: Database; readOnly: boolean } {
  if (!path) return setUp(":memory:");
  // The packaged app's smoke check: a database that won't open fails the launch.
  if (process.env.PONZU_DB_STRICT) return setUp(path);
  try {
    return setUp(path);
  } catch (err) {
    if (unusable(err)) {
      // Rediscovered from scratch; only what the person did is lost. Each move on its own:
      // another process recovering the same file may have moved it already, or the folder
      // may not let us. Only the process that moved the database itself starts the new
      // one; the others run from memory rather than move a database just started.
      const aside = `${path}.corrupt-${Date.now()}-${process.pid}`;
      let moved = false;
      for (const ext of ["", "-wal", "-shm"]) {
        try {
          renameSync(path + ext, aside + ext);
          if (ext === "") moved = true;
        } catch {}
      }
      if (moved)
        try {
          return setUp(path);
        } catch {}
    }
    return setUp(":memory:");
  }
}

function setUp(path: string): { db: Database; readOnly: boolean } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    let version = userVersion(db);
    if (version < SCHEMA) {
      if (version > 0) backUp(db, path, version);
      // One process migrates; the others wait here, then find it done.
      db.exec("BEGIN IMMEDIATE");
      try {
        version = userVersion(db);
        for (let v = version; v < SCHEMA; v++) db.exec(MIGRATIONS[v]!);
        if (version < SCHEMA) {
          db.exec(`PRAGMA user_version = ${SCHEMA}`);
          db.query(
            "INSERT INTO meta (key, value) VALUES ('min_reader', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1",
          ).run(String(MIN_READER));
          version = SCHEMA;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
    // A newer build's database: used as is while this build can still read it.
    const min = Number(
      (
        db.query("SELECT value FROM meta WHERE key = 'min_reader'").get() as {
          value: string;
        } | null
      )?.value ?? version,
    );
    return { db, readOnly: version > SCHEMA && SCHEMA < min };
  } catch (err) {
    db.close();
    throw err;
  }
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** A copy before a migration changes a database that has the person's choices in it. */
function backUp(db: Database, path: string, version: number): void {
  if (path === ":memory:") return;
  const to = `${path}.bak-v${version}`;
  try {
    if (!existsSync(to)) db.query("VACUUM INTO ?").run(to);
  } catch {}
}

function unusable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return /NOTADB|CORRUPT|not a database|malformed/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
}
