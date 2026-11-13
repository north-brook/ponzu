// Preloaded by `bun test` (bunfig.toml), first. When PONZU_TEST_TRACE names a folder, each
// `--parallel` worker keeps one small file there saying which test file it is on and how far it
// has got, so scripts/ci/test-watchdog.ts can name what was still running when CI cuts the job
// off. A test that blocks its worker's thread (a synchronous spawn that never returns, say) also
// blocks bun's own timeout, so the run would otherwise end in silence. Unset, this does nothing.
//
// Only in a worker: there the preload runs again before each file, with Bun.main set to it. A
// run without --parallel preloads once, so it could not say which file it is on.
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** What a worker last wrote: the file it is on, and where in it. */
export interface Trace {
  pid: number;
  worker: string;
  /** Relative to the working directory bun test ran in. */
  file: string;
  /** Milliseconds since the epoch when the worker started on this file. */
  since: number;
  /** "loading" until the file's tests begin; "done" once its last hook has run. */
  stage: "loading" | "running" | "done";
  /** Tests that have begun, and tests that have ended (passed, failed or timed out). */
  begun: number;
  ended: number;
}

const folder = process.env.PONZU_TEST_TRACE;
const worker = process.env.BUN_TEST_WORKER_ID;

if (folder && worker !== undefined) {
  const path = join(folder, `${process.pid}.json`);
  const trace: Trace = {
    pid: process.pid,
    worker,
    file: relative(process.cwd(), Bun.main),
    since: Date.now(),
    stage: "loading",
    begun: 0,
    ended: 0,
  };
  // Synchronous, so the record is on disk before the next line of the test can block.
  const write = () => writeFileSync(path, JSON.stringify(trace));
  write();
  beforeAll(() => {
    trace.stage = "running";
    write();
  });
  beforeEach(() => {
    trace.begun++;
    write();
  });
  afterEach(() => {
    trace.ended++;
    write();
  });
  afterAll(() => {
    trace.stage = "done";
    write();
  });
}
