import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalsApiKey, withoutSecret } from "./key.ts";
import { SpendCapReached } from "./meter.ts";
import { pool } from "./pool.ts";

/*
 * A judge is checked the way code is: against labelled examples it must get right. Each label
 * is one criterion of one example (an idea is "safe", a closing message "fail"), and the score is
 * labels right of labels given. A calibration passes when every label is right, except those
 * marked `unsettled` (a call the founder has yet to make), which are reported and never count
 * against it. It is recorded under the judge's version (model and prompt), and a suite refuses a
 * judge whose version has no passing calibration.
 */

export interface Example<I, L> {
  id: string;
  /** Why it is here: a clear pass, a clear failure, the case that bit us. */
  note: string;
  /** A hard case: still must be right, and said so in the report. */
  hard?: boolean;
  /** Its labels are a call the founder has yet to make: reported, never counted against. */
  unsettled?: boolean;
  input: I;
  expect: L;
}

export interface Miss {
  label: string;
  expected: string;
  got: string;
  reason: string;
}

export interface ExampleResult {
  id: string;
  note: string;
  hard: boolean;
  unsettled: boolean;
  labels: number;
  misses: Miss[];
  /** What the judge said, every criterion with its reason, for reading the report. */
  said: unknown;
  error?: string;
}

export interface Calibration {
  judge: string;
  model: string;
  version: string;
  at: string;
  commit: string | null;
  right: number;
  total: number;
  passed: boolean;
  usd: number;
  examples: ExampleResult[];
}

export async function calibrate<I, L, V>({
  judge,
  model,
  version,
  commit,
  examples,
  run,
  compare,
  spent,
  concurrency = 4,
}: {
  judge: string;
  model: string;
  version: string;
  commit: string | null;
  examples: readonly Example<I, L>[];
  run(input: I): Promise<V>;
  /** Each labelled criterion: how many there were, and those the judge got wrong. */
  compare(expect: L, got: V): { labels: number; misses: Miss[] };
  /** Dollars spent so far, read before and after. */
  spent(): number;
  concurrency?: number;
}): Promise<Calibration> {
  const before = spent();
  const results = await pool(examples, concurrency, async (example): Promise<ExampleResult> => {
    const base = {
      id: example.id,
      note: example.note,
      hard: Boolean(example.hard),
      unsettled: Boolean(example.unsettled),
    };
    try {
      const got = await run(example.input);
      const { labels, misses } = compare(example.expect, got);
      return { ...base, labels, misses, said: got };
    } catch (error) {
      if (error instanceof SpendCapReached) throw error;
      // A judge that gives no answer gets every label of the example wrong.
      const { labels } = compare(example.expect, null as V);
      return {
        ...base,
        labels,
        misses: [{ label: "*", expected: "an answer", got: "none", reason: String(error) }],
        said: null,
        error: String(error),
      };
    }
  });
  let right = 0;
  let total = 0;
  let passed = true;
  for (const result of results) {
    const wrong = result.error ? result.labels : result.misses.length;
    total += result.labels;
    right += result.labels - wrong;
    if (wrong > 0 && !result.unsettled) passed = false;
  }
  return {
    judge,
    model,
    version,
    at: new Date().toISOString(),
    commit,
    right,
    total,
    passed,
    usd: spent() - before,
    examples: results,
  };
}

const FILE = "calibration.json";

export function readCalibrations(dir: string): Record<string, Calibration> {
  const file = join(dir, FILE);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, Calibration>;
}

export function writeCalibration(dir: string, calibration: Calibration): void {
  mkdirSync(dir, { recursive: true });
  const all = readCalibrations(dir);
  all[calibration.judge] = calibration;
  // Never the evals' key, whatever a judge or an error repeated of it.
  const json = `${JSON.stringify(all, null, 2)}\n`;
  writeFileSync(join(dir, FILE), withoutSecret(json, evalsApiKey() ?? ""));
}

export class Uncalibrated extends Error {
  override name = "Uncalibrated";
}

/** Throws unless `judge` at `version` has a passing calibration recorded in `dir`. */
export function requireCalibrated(dir: string, judge: string, version: string): Calibration {
  const recorded = readCalibrations(dir)[judge];
  if (!recorded || recorded.version !== version) {
    throw new Uncalibrated(
      `The ${judge} judge (version ${version}) has no calibration: run \`bun run evals judges\` first.`,
    );
  }
  if (!recorded.passed) {
    throw new Uncalibrated(
      `The ${judge} judge (version ${version}) got ${recorded.total - recorded.right} of its labelled examples wrong: fix its rubric and run \`bun run evals judges\` again.`,
    );
  }
  return recorded;
}

/** Each labelled criterion, compared: `expect` holds only the criteria an example labels. */
export function compareLabels(
  prefix: string,
  expect: Record<string, string | boolean | undefined>,
  got: Record<string, unknown> | null | undefined,
  reason: string,
): { labels: number; misses: Miss[] } {
  let labels = 0;
  const misses: Miss[] = [];
  for (const [label, want] of Object.entries(expect)) {
    if (want === undefined) continue;
    labels++;
    const value = got?.[label];
    if (value !== want) {
      misses.push({
        label: `${prefix}${label}`,
        expected: String(want),
        got: String(value),
        reason,
      });
    }
  }
  return { labels, misses };
}
