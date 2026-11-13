import { SEARCH_REINDEX_JOB } from "@ponzu/db";
import { runSearchReindexJob } from "../../search/reindex.ts";
import type { JobKinds } from "../registry.ts";

/** Search: rebuilding one canvas's entries whole. */
export const searchJobs = (): JobKinds => ({
  [SEARCH_REINDEX_JOB]: runSearchReindexJob,
});
