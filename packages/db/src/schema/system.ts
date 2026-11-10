import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { WEBHOOK_SOURCES } from "../enums.ts";
import { createdAt, instant, type Json, oneOf } from "./columns.ts";

/**
 * Work that must finish even if the function that started it does not: a request records the
 * job and runs it, and the one-minute cron takes whatever is left.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    // Free text: the kinds belong to the code that runs them.
    kind: text("kind").notNull(),
    /** What the job is about, like a design id. One waiting job per kind and key. */
    key: text("key"),
    payload: jsonb("payload").$type<Json>().notNull().default({}),
    runAt: instant("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: instant("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    completedAt: instant("completed_at"),
    /** Set when it ran out of attempts. Like a completed job it is over, and its key is free. */
    failedAt: instant("failed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("jobs_run_at_pending_idx")
      .on(t.runAt)
      .where(sql`${t.completedAt} is null and ${t.failedAt} is null`),
    uniqueIndex("jobs_kind_key_pending_key")
      .on(t.kind, t.key)
      .where(sql`${t.completedAt} is null and ${t.failedAt} is null`),
    check("jobs_locked_by_check", sql`(${t.lockedAt} is null) = (${t.lockedBy} is null)`),
    check("jobs_ended_check", sql`${t.completedAt} is null or ${t.failedAt} is null`),
  ],
);

/** A webhook we have already taken, so a redelivery is not processed twice. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    source: text("source", { enum: WEBHOOK_SOURCES }).notNull(),
    /** The sender's id for the delivery. */
    deliveryId: text("delivery_id").notNull(),
    event: text("event").notNull(),
    receivedAt: instant("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.deliveryId] }),
    check("webhook_deliveries_source_check", oneOf(t.source, WEBHOOK_SOURCES)),
  ],
);
