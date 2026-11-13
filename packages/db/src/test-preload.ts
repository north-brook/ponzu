// Preloaded by `bun test` (bunfig.toml) in every process that runs test files, before the first
// one loads: the test databases' copies are made here, outside any test's or hook's timeout, so
// a test only ever loads one (testing.ts). Warm, this reads two files; cold, the first process
// runs initdb and the migrations once while the others wait on its lock.
import { prepareTestDbs } from "./testing.ts";

await prepareTestDbs();
