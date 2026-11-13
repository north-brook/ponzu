// Preloaded by `bun test` (bunfig.toml) in every process that runs test files, before the first
// one loads: the test databases' copies are made here, outside any test's or hook's timeout, so
// a test only ever loads one (testing.ts). Warm, this reads two files; cold, the first process
// runs initdb and the migrations once while the others wait on its lock.
import { prepareTestDbs } from "./testing.ts";

await prepareTestDbs();
// For testing.test.ts: this process was preloaded. A `bun test` run from another directory does
// not read the root bunfig, has no preload, and makes its copy in the first test that asks.
process.env.PONZU_TEST_DBS_PRELOADED = "1";
