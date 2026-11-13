import { defineNotice } from "./define.ts";

/**
 * Billing on Ponzu starts (the terms: at least 30 days ahead, by email). It goes to every admin
 * of every organisation's workspace and to the person of each personal workspace. Its prices
 * are the published rate card's (@ponzu/db/rate-card), so the email and the pricing page
 * cannot disagree; the rate card must be final before it is sent.
 *
 * The day is the founder's to write, when PONZU_BILLING=on in production is planned: at least
 * 30 days after this is sent, which the script enforces. Until it is written the script
 * refuses to send it.
 */
export default defineNotice({
  id: "billing-starts",
  kind: "billing_starts",
  effective: null,
});
