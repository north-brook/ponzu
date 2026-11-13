import { check, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { EMAIL_NOTICE_OUTCOMES } from "../enums.ts";
import { instant, oneOf } from "./columns.ts";

/**
 * A legal notice Ponzu emailed to one person (docs/cloud.md, "Email"): the terms promise some
 * things by email (billing starting, a price rise, a change that takes a right away, shutting
 * down, a suspension), and this is the record that each went. Only the founder's notice script
 * writes it.
 *
 * A row is written `pending` before the send and gets its outcome after, so a script that dies
 * between the two leaves a row that says so. A rerun sends only to people with no row or a
 * `pending` one less than a day old (Resend's idempotency key still holds then); an older
 * `pending` row is listed, never sent again.
 *
 * `user_id` has no foreign key on purpose: the record outlives a deleted account, for as long
 * as docs/legal.md says it is kept. `address` is where it went, for the same reason.
 */
export const emailNotices = pgTable(
  "email_notices",
  {
    /** The notice file's id (apps/api/src/email/notices/<id>.ts). */
    noticeId: text("notice_id").notNull(),
    userId: text("user_id").notNull(),
    /**
     * The workspace a suspension was for. Null for every other notice: billing starting and a
     * price rise go once to each person and name no workspace.
     */
    workspaceId: text("workspace_id"),
    /** The address it went to; null when the person had none. */
    address: text("address"),
    sentAt: instant("sent_at"),
    /** Resend's id for the email. */
    resendId: text("resend_id"),
    outcome: text("outcome", { enum: EMAIL_NOTICE_OUTCOMES }).notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.noticeId, t.userId] }),
    check("email_notices_outcome_check", oneOf(t.outcome, EMAIL_NOTICE_OUTCOMES)),
  ],
);
