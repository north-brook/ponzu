import { defineNotice } from "./define.ts";

/**
 * Not a real notice: the one the orchestrator sends on dev, to the founder's allowlisted
 * address, to check the script, the record and the email end to end. Refused on production.
 */
export default defineNotice({
  id: "dev-check",
  kind: "terms_change",
  devOnly: true,
  effective: "2099-01-01",
  summary: [
    "This is a check of how Ponzu sends legal notices, sent on dev only. Nothing in the terms changes.",
  ],
});
