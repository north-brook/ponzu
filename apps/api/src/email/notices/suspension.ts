import { defineNotice } from "./define.ts";

/**
 * An account or a workspace is suspended (the terms: we tell you by email). Nothing about a
 * case is written here: the founder names the people (`--user`), the workspace if it is one
 * (`--workspace`), a short id for the case (`--case`, so a later suspension of the same person
 * is a record of its own) and the reason (`--reason-file`, at most 1,000 characters, sent as
 * escaped text).
 */
export default defineNotice({
  id: "suspension",
  kind: "suspension",
});
