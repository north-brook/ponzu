#!/usr/bin/env bun
/**
 * Migrations are expand first, contract later (docs/production.md, "Backups and restore"): a
 * deploy runs the new migrations before the new code, and Vercel's instant rollback puts older
 * code back on the newer schema, so no migration may take away something a deployed API still
 * reads or writes. This fails on a statement that does, unless the line right before it says
 * why it is safe now:
 *
 *   -- contract: <why nothing deployed reads it any more>
 *   ALTER TABLE "x" DROP COLUMN "y";--> statement-breakpoint
 *
 * What counts as taking something away: DROP TABLE, DROP COLUMN, any RENAME, a column's type
 * changed (ALTER COLUMN … TYPE), SET NOT NULL, ADD COLUMN … NOT NULL with no DEFAULT (an
 * older API's inserts leave it out), TRUNCATE, and DROP SCHEMA or VIEW. In an ALTER TABLE the
 * word COLUMN is optional, as it is to Postgres. Words inside string literals count too, so
 * dynamic SQL in a DO block (`EXECUTE format('… RENAME …')`) is caught; comments do not, and
 * comments are found the way Postgres finds them (E'…' escapes, `$tag1$` dollar quotes).
 *
 * Narrowing a check constraint (DROP CONSTRAINT then ADD) is not caught: telling a widening from
 * a narrowing needs the reviewer.
 *
 *   bun scripts/ci/migrations.ts [dir]   every migration in packages/db/migrations (or dir)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migrations from before this lint, each with why it may break the rule. Applied migrations
 * are never edited, so they are listed here instead of gaining a contract line. Nothing is
 * added to this list: a new contract statement carries its `-- contract:` line.
 */
export const GRANDFATHERED: Record<string, string> = {
  "0007_runner_protocol.sql":
    "Before any deploy served people: the runner protocol replaced member_repos and the sandbox's session column on dev only.",
  "0023_vercel_sandboxes.sql":
    "Before any deploy served people: the move to Vercel Sandbox dropped the old sandboxes table and its columns on dev only, deployed with the API that stopped reading them.",
  "0025_canvases.sql":
    "The rename to canvases, program.md section 4's one documented exception: run with every sandbox asleep, paired with the deploy that reads the new names, and never rolled back past (docs/production.md).",
};

/**
 * Each grandfathered file's SHA-256 as it was applied. A grandfathered file that changes is
 * linted again, so a statement added to it later cannot ride on its exception.
 */
export const GRANDFATHERED_SHA256: Record<string, string> = {
  "0007_runner_protocol.sql": "95378625840432b1dfa62555d3d4f8e80ce9b549f94951a8fb534d7316a53566",
  "0023_vercel_sandboxes.sql": "9647c4bf2d6e3f579efe02fc81a9d89b683ec60eafea11493612a1e5287dbd74",
  "0025_canvases.sql": "a28c1d1389c1807fd6a2ab8cd6c068bbd0451f80a7fe1470f56b73bae09ad6cb",
};

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export interface Finding {
  file: string;
  line: number;
  rule: string;
  statement: string;
}

/** In an ALTER TABLE, the word COLUMN is optional: `DROP "b"` drops the column b. */
const NOT_A_COLUMN_DROP = /^(?:TABLE|CONSTRAINT|DEFAULT|NOT\s+NULL|EXPRESSION|IDENTITY)\b/;
const NOT_A_COLUMN_ADD = /^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE|VALUE)\b/;

/** Each `verb` action of an ALTER TABLE statement, from the word after the verb to its end. */
function actions(code: string, verb: "ADD" | "DROP"): string[] {
  if (!/\bALTER\s+TABLE\b/.test(code)) return [];
  return code
    .split(new RegExp(`\\b${verb}\\s+`))
    .slice(1)
    .map((part) => part.split(/,\s*(?:ADD|ALTER|DROP)\b/)[0] ?? "");
}

const RULES: { rule: string; test: (code: string) => boolean }[] = [
  { rule: "DROP TABLE", test: (c) => /\bDROP\s+TABLE\b/.test(c) },
  {
    rule: "DROP COLUMN",
    test: (c) =>
      /\bDROP\s+COLUMN\b/.test(c) ||
      actions(c, "DROP").some((action) => !NOT_A_COLUMN_DROP.test(action)),
  },
  { rule: "RENAME", test: (c) => /\bRENAME\b/.test(c) },
  {
    rule: "ALTER COLUMN … TYPE",
    test: (c) => /\bALTER\s+(?:COLUMN\s+)?(?:"[^"]*"|%I|\S+)\s+(?:SET\s+DATA\s+)?TYPE\b/.test(c),
  },
  { rule: "SET NOT NULL", test: (c) => /\bSET\s+NOT\s+NULL\b/.test(c) },
  {
    rule: "ADD COLUMN … NOT NULL without a DEFAULT",
    test: (c) =>
      actions(c, "ADD")
        .filter((action) => !NOT_A_COLUMN_ADD.test(action))
        .some((clause) => /\bNOT\s+NULL\b/.test(clause) && !/\b(DEFAULT|GENERATED)\b/.test(clause)),
  },
  { rule: "TRUNCATE", test: (c) => /\bTRUNCATE\b/.test(c) },
  {
    rule: "DROP SCHEMA or VIEW",
    test: (c) => /\bDROP\s+(?:SCHEMA|VIEW|MATERIALIZED\s+VIEW)\b/.test(c),
  },
];

interface Statement {
  /** 1-based line of the statement's first character of code. */
  line: number;
  /** Its code with comments taken out and string literals kept, upper-cased, spaces collapsed. */
  code: string;
}

/** A character that may continue an unquoted name in Postgres. */
const NAME_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
/** A dollar-quote delimiter: `$$` or `$tag$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Splits SQL into statements at top-level semicolons, knowing single-quoted strings, quoted
 * names, dollar quotes (`$$` and `$tag$`), `--` comments and block comments.
 */
export function statements(sql: string): Statement[] {
  const out: Statement[] = [];
  let code = "";
  let start = 0;
  let line = 1;
  let i = 0;
  const flush = () => {
    const text = code.replace(/\s+/g, " ").trim();
    if (text) out.push({ line: start, code: text.toUpperCase() });
    code = "";
    start = 0;
  };
  const take = (text: string) => {
    if (!start && /\S/.test(text))
      start = line + (text.match(/^\s*/)?.[0].split("\n").length ?? 1) - 1;
    code += text;
    line += text.split("\n").length - 1;
  };
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      i += end < 0 ? rest.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      const comment = end < 0 ? rest : rest.slice(0, end + 2);
      line += comment.split("\n").length - 1;
      code += " ";
      i += comment.length;
      continue;
    }
    // As Postgres reads it: `$tag$` opens a dollar quote (a tag may hold digits after its
    // first character), unless the `$` continues a name, as in `a$b$`.
    const inName = i > 0 && NAME_CHAR.test(sql[i - 1] as string);
    const dollar = inName ? undefined : DOLLAR_TAG.exec(rest)?.[0];
    if (dollar) {
      const end = rest.indexOf(dollar, dollar.length);
      const body = end < 0 ? rest : rest.slice(0, end + dollar.length);
      take(body);
      i += body.length;
      continue;
    }
    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      // E'…' takes backslash escapes, so in `E'\''` the middle quote does not end the string.
      const escapes =
        quote === "'" &&
        /[Ee]/.test(sql[i - 1] ?? "") &&
        !(i > 1 && NAME_CHAR.test(sql[i - 2] as string));
      let j = 1;
      while (j < rest.length) {
        if (escapes && rest[j] === "\\") j += 2;
        else if (rest[j] === quote && rest[j + 1] === quote) j += 2;
        else if (rest[j] === quote) break;
        else j++;
      }
      const literal = rest.slice(0, j + 1);
      take(literal);
      i += literal.length;
      continue;
    }
    if (rest[0] === ";") {
      flush();
      i++;
      continue;
    }
    take(rest[0] as string);
    i++;
  }
  flush();
  return out;
}

const CONTRACT = /^\s*--\s*contract:\s*\S/i;

/** Every statement in `sql` that takes something away without a contract line right before it. */
export function lintMigration(file: string, sql: string): Finding[] {
  const lines = sql.split("\n");
  const findings: Finding[] = [];
  for (const statement of statements(sql)) {
    const broken = RULES.filter((r) => r.test(statement.code));
    if (!broken.length) continue;
    if (CONTRACT.test(lines[statement.line - 2] ?? "")) continue;
    for (const { rule } of broken)
      findings.push({
        file,
        line: statement.line,
        rule,
        statement: (lines[statement.line - 1] ?? "").trim(),
      });
  }
  return findings;
}

/** Every migration in `dir`, but a grandfathered one only if it changed since it was listed. */
export function lintMigrations(dir: string): Finding[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      if (name in GRANDFATHERED && sha256(sql) === GRANDFATHERED_SHA256[name]) return [];
      return lintMigration(name, sql);
    });
}

if (import.meta.main) {
  const dir = process.argv[2] ?? join(import.meta.dir, "../../packages/db/migrations");
  const findings = lintMigrations(dir);
  for (const f of findings) {
    const message = `${f.rule} takes away what a deployed API may still use. Expand first and contract in a later pull request, after the deploy; then put "-- contract: <why it is safe now>" on the line before.`;
    console.log(`::error file=packages/db/migrations/${f.file},line=${f.line}::${message}`);
    console.error(`${f.file}:${f.line}: ${f.rule}: ${f.statement}`);
  }
  if (findings.length) process.exit(1);
  console.log("Every migration is expand-only, or says why it contracts.");
}
