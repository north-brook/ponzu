#!/usr/bin/env bun
/**
 * The migration guard: a change's migrations, judged against the main it lands on. Many lanes
 * merge to main without knowing about each other, and a merge to main migrates production by
 * itself, so CI ("Migrations" in ci.yml, on every pull request and every merge-queue entry)
 * fails a change when:
 *
 * - its migration is not the next after main's newest: its number is taken, main's newest is
 *   missing from its journal, or its `when` is not newer than every migration main has (Drizzle
 *   skips a migration older than the newest one applied);
 * - its drizzle snapshot chain does not follow main's (its snapshot's `prevId` is not main's
 *   newest snapshot's `id`), or the chain, the numbers and the journal disagree anywhere;
 * - it edits or removes a migration main already has;
 * - it adds more than one migration;
 * - it is not expand only: the statements `scripts/ci/migrations.ts` refuses (drops, renames,
 *   type changes, NOT NULL without a default, …), unless a `-- contract:` line says why;
 * - it locks a table main already has without `lock_timeout` set first. Every statement that
 *   names such a table (an ALTER, an index, a foreign key that references it, an UPDATE) holds
 *   a lock on it until the migration commits, and without a timeout a long transaction makes
 *   every request behind it wait. `0031_search` is the pattern: `SET LOCAL lock_timeout = '5s'`
 *   as the first statement, under a `-- hand-written (…)` line.
 *
 * Its failure says what to run. A migration whose number another lane took first is renumbered
 * by `renumber`, which does what a lander used to do by hand: take main's journal and snapshots, delete
 * this branch's migration, `db:generate` it again under the next number, and put the
 * hand-written lines back.
 *
 *   bun scripts/ci/migration-guard.ts check --base <ref> [--head <ref>]
 *                                                             judge the working tree's migrations
 *                                                             (or <head>'s) against <base>'s
 *   bun scripts/ci/migration-guard.ts renumber [--base <ref>] renumber this branch's migration
 *                                                             after <ref> (default origin/main)
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { lintMigration, statements } from "./migrations.ts";

export const ROOT = join(import.meta.dir, "../..");
/** The migrations folder, from the repository's root. */
export const MIGRATIONS = "packages/db/migrations";
const ZERO_ID = "00000000-0000-0000-0000-000000000000";
const TAG = /^(\d{4})_[a-z0-9_]+$/;
const BREAK = "--> statement-breakpoint";

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** A migrations folder: its journal, and every file in it by its path inside the folder. */
export interface Migrations {
  journal: { version: string; dialect: string; entries: JournalEntry[] };
  files: Record<string, string>;
}

export interface Problem {
  rule: string;
  /** The file inside the migrations folder it is about, if one. */
  file?: string;
  line?: number;
  message: string;
}

/** Every file under `dir`, read. */
export function readMigrations(dir: string): Migrations {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(dir, path).split("\\").join("/")] = readFileSync(path, "utf8");
  }
  const raw = files["meta/_journal.json"];
  const journal = raw
    ? (JSON.parse(raw) as Migrations["journal"])
    : { version: "7", dialect: "postgresql", entries: [] };
  return { journal, files };
}

async function run(cmd: string[], cwd = ROOT): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, out };
}

/** Extracts `paths` of the tree at `ref` into a new temporary folder, and gives its path. */
export async function extractTree(ref: string, paths: string[] = [], cwd = ROOT): Promise<string> {
  const out = mkdtempSync(join(tmpdir(), "ponzu-tree-"));
  const archive = Bun.spawn(["git", "archive", "--format=tar", ref, "--", ...paths], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const tar = Bun.spawn(["tar", "-x", "-C", out], {
    stdin: archive.stdout,
    stdout: "inherit",
    stderr: "inherit",
  });
  const [archived, extracted] = await Promise.all([archive.exited, tar.exited]);
  if (archived !== 0 || extracted !== 0) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(`could not read ${paths.join(" ") || "the tree"} at ${ref}`);
  }
  return out;
}

/** The migrations folder as it is at a git ref. A ref without one has no migrations. */
export async function readMigrationsAt(ref: string, cwd = ROOT): Promise<Migrations> {
  const out = await extractTree(ref, [MIGRATIONS], cwd);
  try {
    return readMigrations(join(out, MIGRATIONS));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const snapshotOf = (tag: string) => `meta/${tag.slice(0, 4)}_snapshot.json`;

function snapshot(m: Migrations, tag: string): { id?: string; prevId?: string; tables?: object } {
  try {
    return JSON.parse(m.files[snapshotOf(tag)] ?? "{}");
  } catch {
    return {};
  }
}

/** The names of the tables a migrations folder's newest snapshot holds. */
export function tablesOf(m: Migrations): string[] {
  const last = m.journal.entries.at(-1);
  if (!last) return [];
  const tables = (snapshot(m, last.tag).tables ?? {}) as Record<string, { name?: string }>;
  return Object.entries(tables).map(([key, table]) => table.name ?? key.replace(/^\w+\./, ""));
}

/** The folder on its own: numbers, files and the snapshot chain agree with the journal. */
export function judgeTree(m: Migrations): Problem[] {
  const out: Problem[] = [];
  const tags = new Set<string>();
  const numbers = new Map<string, string>();
  m.journal.entries.forEach((entry, i) => {
    const match = TAG.exec(entry.tag);
    if (!match) {
      out.push({
        rule: "name",
        message: `Journal entry ${i}, "${entry.tag}", is not named NNNN_name.`,
      });
      return;
    }
    const number = match[1] as string;
    const other = numbers.get(number);
    if (other) {
      out.push({
        rule: "number taken",
        file: `${entry.tag}.sql`,
        message: `${entry.tag} and ${other} both have the number ${number}.`,
      });
    } else if (entry.idx !== i || Number(number) !== i) {
      out.push({
        rule: "number",
        file: `${entry.tag}.sql`,
        message: `${entry.tag} is entry ${i} of the journal (idx ${entry.idx}), so its number must be ${String(i).padStart(4, "0")}.`,
      });
    }
    numbers.set(number, entry.tag);
    tags.add(entry.tag);
    if (!(`${entry.tag}.sql` in m.files)) {
      out.push({
        rule: "missing file",
        message: `The journal lists ${entry.tag}, but ${entry.tag}.sql is not there.`,
      });
    }
    if (!(snapshotOf(entry.tag) in m.files)) {
      out.push({
        rule: "missing snapshot",
        message: `The journal lists ${entry.tag}, but ${snapshotOf(entry.tag)} is not there.`,
      });
    }
  });
  const snapshots = new Set(m.journal.entries.map((e) => snapshotOf(e.tag)));
  for (const file of Object.keys(m.files).sort()) {
    const stray =
      (file.endsWith(".sql") && !tags.has(file.slice(0, -4))) ||
      (/^meta\/\d{4}_snapshot\.json$/.test(file) && !snapshots.has(file));
    if (stray) {
      out.push({
        rule: "not in the journal",
        file,
        message: `${file} is not in meta/_journal.json, so no migrator ever applies it.`,
      });
    }
  }
  let prev = ZERO_ID;
  const ids = new Set<string>();
  for (const entry of m.journal.entries) {
    if (!TAG.test(entry.tag)) continue;
    const snap = snapshot(m, entry.tag);
    if (!snap.id) {
      // A snapshot with no id (or that is not JSON) breaks the chain for the next generate.
      if (snapshotOf(entry.tag) in m.files) {
        out.push({
          rule: "snapshot chain",
          file: snapshotOf(entry.tag),
          message: `${snapshotOf(entry.tag)} has no id, so no snapshot after it can follow it. Regenerate it with db:generate.`,
        });
      }
      continue;
    }
    if (snap.prevId !== prev) {
      out.push({
        rule: "snapshot chain",
        file: snapshotOf(entry.tag),
        message: `${entry.tag}'s snapshot follows ${snap.prevId ?? "nothing"}, but the snapshot before it is ${prev}.`,
      });
    }
    if (ids.has(snap.id)) {
      out.push({
        rule: "snapshot chain",
        file: snapshotOf(entry.tag),
        message: `${entry.tag}'s snapshot id ${snap.id} is used twice.`,
      });
    }
    ids.add(snap.id);
    prev = snap.id;
  }
  return out;
}

/**
 * `SET [LOCAL|SESSION] lock_timeout` to a number, as `statements` gives it (upper-cased). Zero
 * and DEFAULT mean no timeout at all, so they do not count.
 */
const LOCK_TIMEOUT = /^SET\s+(?:LOCAL\s+|SESSION\s+)?LOCK_TIMEOUT\s*(?:=|\bTO\b)\s*'?\s*(\d+)/;
const setsLockTimeout = (code: string) => Number(LOCK_TIMEOUT.exec(code)?.[1] ?? 0) > 0;
/** Any statement that changes lock_timeout, to a value, to DEFAULT, or back with RESET. */
const CHANGES_LOCK_TIMEOUT =
  /^(?:SET\s+(?:LOCAL\s+|SESSION\s+)?LOCK_TIMEOUT\b|RESET\s+(?:LOCK_TIMEOUT|ALL)\b)/;

/**
 * The first statement that names one of `existing` before any `lock_timeout` is set. A name
 * counts quoted anywhere (Drizzle quotes every name it writes), or unquoted after a word that
 * takes a table.
 */
export function lockProblems(file: string, sql: string, existing: string[]): Problem[] {
  const quote = (s: string) => s.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = existing.map((name) => ({
    name,
    test: new RegExp(
      `"${quote(name)}"|\\b(?:TABLE|ON|REFERENCES|INTO|UPDATE|FROM|JOIN|TRUNCATE)\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?(?:PUBLIC\\.)?${quote(name)}\\b`,
    ),
  }));
  // Whether a positive lock_timeout holds at this statement. A later SET to zero or DEFAULT, or
  // a RESET, turns it off again, so every statement is judged by the newest setting before it.
  let timeout = false;
  for (const statement of statements(sql)) {
    if (CHANGES_LOCK_TIMEOUT.test(statement.code)) {
      timeout = setsLockTimeout(statement.code);
      continue;
    }
    if (timeout) continue;
    const hit = patterns.find((p) => p.test.test(statement.code));
    if (hit) {
      return [
        {
          rule: "lock_timeout",
          file,
          line: statement.line,
          message: `This statement locks "${hit.name}", a table main already has, until the migration commits, with no lock_timeout set, so a long transaction on it would hold every request behind the migration. Make the migration's first statement "SET LOCAL lock_timeout = '5s';${BREAK}" under a "-- hand-written (…)" line, as 0031_search does.`,
        },
      ];
    }
  }
  return [];
}

/**
 * How to renumber, in the words a failure prints. CI judges against a commit (the merge's base,
 * or the queue entry ahead, which may never land), so a lane renumbers onto origin/main instead.
 */
export function renumberAdvice(judgedAgainst: string): string {
  const base = /^[0-9a-f]{40}$/.test(judgedAgainst) ? "origin/main" : judgedAgainst;
  return [
    "Renumber this branch's migration onto main's:",
    "  git fetch origin && git merge origin/main   (a conflict in packages/db/migrations is fine: the next line settles it)",
    `  bun scripts/ci/migration-guard.ts renumber --base ${base}`,
    "  git add packages/db/migrations && git commit",
    "It takes main's journal and snapshots, deletes this branch's migration, runs db:generate again under the next number, and puts the hand-written lines back.",
  ].join("\n");
}

/**
 * HEAD's migrations against the base it lands on: what judgeTree finds in HEAD, a change to
 * anything the base has, more than one new migration, and each new one's number, `when`,
 * snapshot, expand-only lint and lock timeout.
 */
export function judge(
  base: Migrations,
  head: Migrations,
): { added: JournalEntry[]; problems: Problem[] } {
  const problems = judgeTree(head);
  const baseEntries = base.journal.entries;
  const headEntries = head.journal.entries;
  let renumber = false;
  if (
    base.journal.version !== head.journal.version ||
    base.journal.dialect !== head.journal.dialect
  ) {
    problems.push({
      rule: "journal",
      file: "meta/_journal.json",
      message: "The journal's version or dialect differs from main's.",
    });
  }
  baseEntries.forEach((entry, i) => {
    const mine = headEntries[i];
    if (!mine || JSON.stringify(mine) !== JSON.stringify(entry)) {
      renumber = true;
      problems.push({
        rule: "not after main",
        file: "meta/_journal.json",
        message: mine
          ? `Main's migration ${i} is ${entry.tag}; this change has ${mine.tag} there.`
          : `Main has ${entry.tag}, and this change's journal does not.`,
      });
    }
  });
  for (const [file, text] of Object.entries(base.files)) {
    if (file === "meta/_journal.json") continue;
    if (head.files[file] === text) continue;
    problems.push({
      rule: "applied migration changed",
      file,
      message:
        file in head.files
          ? `${file} differs from main's. Main's migrations are applied when they merge: never edit one. If this change's migration has the same number, renumber it.`
          : `Main has ${file}, and this change does not: merge origin/main.`,
    });
  }
  const added = headEntries.slice(baseEntries.length);
  if (added.length > 1) {
    problems.push({
      rule: "more than one migration",
      message: `This change adds ${added.length} migrations (${added.map((e) => e.tag).join(", ")}). Add one: delete them and run db:generate once, then put the hand-written lines back.`,
    });
  }
  const newest = Math.max(0, ...baseEntries.map((e) => e.when));
  const baseLast = baseEntries.at(-1);
  const baseLastId = baseLast ? snapshot(base, baseLast.tag).id : ZERO_ID;
  const tables = tablesOf(base);
  for (const [k, entry] of added.entries()) {
    const file = `${entry.tag}.sql`;
    if (entry.when <= newest) {
      renumber = true;
      problems.push({
        rule: "older than main's newest",
        file: "meta/_journal.json",
        message: `${entry.tag} was made at ${new Date(entry.when).toISOString()}, before main's newest migration (${new Date(newest).toISOString()}). db:migrate skips a migration older than the newest one applied.`,
      });
    }
    if (k === 0 && snapshot(head, entry.tag).prevId !== baseLastId) {
      renumber = true;
      problems.push({
        rule: "snapshot chain",
        file: snapshotOf(entry.tag),
        message: `${entry.tag}'s snapshot follows ${snapshot(head, entry.tag).prevId ?? "nothing"}, not main's newest snapshot ${baseLastId}.`,
      });
    }
    const sql = head.files[file];
    if (sql === undefined) continue;
    for (const finding of lintMigration(file, sql)) {
      problems.push({
        rule: "not expand only",
        file,
        line: finding.line,
        message: `${finding.rule} takes away what the API running now may still use: a merge migrates production before the new API is live, and the old API runs on the new schema meanwhile. Expand first and contract in a later pull request, once nothing deployed uses it; then put "-- contract: <why it is safe now>" on the line before.`,
      });
    }
    problems.push(...lockProblems(file, sql, tables));
  }
  if (renumber) {
    problems.push({ rule: "renumber", message: "See below for how to renumber." });
  }
  return { added, problems };
}

function report(problems: Problem[], base: string): void {
  const needsRenumber = problems.some((p) => p.rule === "renumber");
  for (const p of problems.filter((p) => p.rule !== "renumber")) {
    const where = p.file ? ` file=${MIGRATIONS}/${p.file}${p.line ? `,line=${p.line}` : ""}` : "";
    const title = `Migration guard: ${p.rule}`;
    const message = p.message.replaceAll("%", "%25").replaceAll("\n", "%0A");
    console.log(`::error${where ? `${where},` : " "}title=${title}::${message}`);
    console.error(`${p.file ? `${p.file}${p.line ? `:${p.line}` : ""}: ` : ""}${p.message}`);
  }
  if (needsRenumber) console.error(`\n${renumberAdvice(base)}`);
}

async function summary(text: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path)
    await Bun.write(
      path,
      `${
        (await Bun.file(path)
          .text()
          .catch(() => "")) + text
      }\n`,
    );
}

async function check(base: string, headRef?: string): Promise<number> {
  const head = headRef ? await readMigrationsAt(headRef) : readMigrations(join(ROOT, MIGRATIONS));
  const { added, problems } = judge(await readMigrationsAt(base), head);
  if (problems.length) {
    report(problems, base);
    await summary(
      `### Migrations\n\nThe migration guard failed against ${base}: ${problems.filter((p) => p.rule !== "renumber").length} problem(s), listed in the log.`,
    );
    return 1;
  }
  const first = added[0];
  const before = first ? head.journal.entries[first.idx - 1] : undefined;
  const said = first
    ? `${first.tag} is the next migration after ${base}'s ${before?.tag ?? "nothing"}, follows its snapshot chain, is expand only, and sets a lock timeout before it locks a table main has.`
    : `No new migration; the ${head.journal.entries.length} migrations agree with their journal and snapshot chain.`;
  console.log(said);
  await summary(`### Migrations\n\n${said}`);
  return 0;
}

// --- renumber -------------------------------------------------------------------------------------

/** The statements of a migration a person wrote: each chunk that starts with a hand-written line. */
export function handWritten(sql: string): string[] {
  return sql
    .split(BREAK)
    .filter((chunk) => /^\s*-- hand-written\b/.test(chunk.trimStart().split("\n")[0] ?? ""));
}

/** A migration without its hand-written chunks and comments, spaces collapsed: what Drizzle wrote. */
export function generatedPart(sql: string): string {
  return sql
    .split(BREAK)
    .filter((chunk) => !/^\s*-- hand-written\b/.test(chunk.trimStart().split("\n")[0] ?? ""))
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

async function renumber(base: string): Promise<number> {
  const dir = join(ROOT, MIGRATIONS);
  const baseMigrations = await readMigrationsAt(base);
  const baseTags = new Set(baseMigrations.journal.entries.map((e) => e.tag));
  const mine = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !baseTags.has(f.slice(0, -4)))
    .sort();
  if (!mine.length) {
    console.log(`This branch adds no migration after ${base}; nothing to renumber.`);
    return 0;
  }
  if (mine.length > 1) {
    console.error(
      `This branch has ${mine.length} migrations main does not (${mine.join(", ")}). Delete all but the newest, run db:generate once, and put their hand-written lines back.`,
    );
    return 1;
  }
  const oldFile = mine[0] as string;
  const oldSql = readFileSync(join(dir, oldFile), "utf8");
  const name = oldFile.slice(5, -4);
  const kept = join(tmpdir(), `ponzu-renumber-${oldFile}`);
  writeFileSync(kept, oldSql);

  // Main's journal and snapshots, conflicted or not; then nothing of this branch's own.
  const restored = await run(["git", "checkout", base, "--", MIGRATIONS]);
  if (restored.code !== 0) return 1;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")))
    if (!baseTags.has(file.slice(0, -4))) rmSync(join(dir, file));
  const baseSnapshots = new Set(baseMigrations.journal.entries.map((e) => snapshotOf(e.tag)));
  for (const file of readdirSync(join(dir, "meta")))
    if (/^\d{4}_snapshot\.json$/.test(file) && !baseSnapshots.has(`meta/${file}`))
      rmSync(join(dir, "meta", file));

  const generated = await run(
    ["bun", "run", "db:generate", "--name", name],
    join(ROOT, "packages/db"),
  );
  if (generated.code !== 0) {
    console.error(`db:generate failed. This branch's migration was kept at ${kept}.`);
    return 1;
  }
  const after = readMigrations(dir);
  const entry = after.journal.entries.at(-1);
  if (!entry || baseTags.has(entry.tag)) {
    console.error(
      `db:generate found nothing to migrate after ${base}: main may already have this change. This branch's migration was kept at ${kept}.`,
    );
    return 1;
  }
  const newFile = `${entry.tag}.sql`;
  const newSql = after.files[newFile] ?? "";
  const pasted = handWritten(oldSql);
  if (generatedPart(newSql) === generatedPart(oldSql)) {
    // Drizzle wrote what it wrote before, so the old file, hand-written lines in their places,
    // is the new one.
    writeFileSync(join(dir, newFile), oldSql);
  } else if (pasted.length) {
    console.error(
      [
        `${newFile} is generated, but Drizzle now writes something other than it did for ${oldFile} (main changed the same tables).`,
        "Put these hand-written lines back where they belong, by hand:",
        ...pasted.map((chunk) => `${chunk.trim()}${BREAK}`),
        `The old migration is kept at ${kept}.`,
      ].join("\n"),
    );
    return 1;
  }
  console.log(`${oldFile} is now ${newFile}, after ${base}'s newest.`);

  // The schema and the migrations agree: a second generate finds nothing to do.
  const before = readFileSync(join(dir, "meta/_journal.json"), "utf8");
  const second = await run(
    ["bun", "run", "db:generate", "--name", "renumber_check"],
    join(ROOT, "packages/db"),
  );
  if (second.code !== 0) {
    console.error(
      `The second db:generate failed (exit ${second.code}), so nothing proves the schema and the migrations agree.\n${second.out}`,
    );
    return 1;
  }
  const again = readMigrations(dir);
  const extra = again.journal.entries.at(-1);
  if (extra && extra.tag !== entry.tag) {
    rmSync(join(dir, `${extra.tag}.sql`), { force: true });
    rmSync(join(dir, snapshotOf(extra.tag)), { force: true });
    writeFileSync(join(dir, "meta/_journal.json"), before);
    console.error(
      "A second db:generate still found changes, so the schema and the migrations disagree. Look at packages/db/src/schema.",
    );
    return 1;
  }
  const { problems } = judge(baseMigrations, readMigrations(dir));
  if (problems.length) {
    report(problems, base);
    return 1;
  }
  console.log("The migration guard passes. Run bun test packages/db/src/schema, then commit.");
  return 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name: string) => {
    const at = rest.indexOf(name);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  const base = option("--base");
  // --head reads HEAD's migrations from a ref instead of the working tree (to try one by hand).
  if (command === "check" && base) process.exit(await check(base, option("--head")));
  if (command === "renumber") process.exit(await renumber(base ?? "origin/main"));
  console.error(
    "usage: bun scripts/ci/migration-guard.ts check --base <ref> | renumber [--base <ref>]",
  );
  process.exit(2);
}
