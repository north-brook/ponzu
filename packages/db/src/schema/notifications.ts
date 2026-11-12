import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import {
  DELIVERY_STATES,
  NOTIFICATION_KINDS,
  NOTIFICATION_OPENS,
  NOTIFICATION_READ_VIA,
  type NotificationOpen,
} from "../enums.ts";
import { devices, users, workspaces } from "./accounts.ts";
import { canvases } from "./canvases.ts";
import { atMostBytes, createdAt, instant, oneOf, updatedAt } from "./columns.ts";

/*
 * What Ponzu told a person, and the pushes that carried it (docs/cloud.md, "Notifications").
 *
 * A `notifications` row is the in-app record, one per person told: it drives the Mac's banner,
 * the dock and phone badge and the read state, and the Mac watches it live. Its words are fixed
 * Ponzu sentences with at most a first name and a pull request number; nothing anyone wrote is
 * in it. A `notification_deliveries` row is one push of it to one iPhone.
 */

/** Where a notification opens, by ids only. */
export interface NotificationLink {
  open: NotificationOpen;
  pageId?: string;
  artboardId?: string;
  commentThreadId?: string;
  questionId?: string;
}

/** How large a notification's link may be. It holds a few ids. */
export const NOTIFICATION_LINK_BYTES = 1024;
/** How long a notification's title or body may be. The copy clips titles far below this. */
export const NOTIFICATION_TEXT_CHARS = 200;

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The workspace it is about. Null for none. */
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    /** The canvas it is about. Null for a billing ping, which is about the workspace. */
    canvasId: text("canvas_id").references(() => canvases.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    /** Unique per person: the same thing never makes two rows for one person. */
    dedupeKey: text("dedupe_key").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    body: text("body").notNull(),
    link: jsonb("link").$type<NotificationLink>().notNull(),
    /** What it is about, to resolve it by: a question, turn, event or review id. */
    sourceId: text("source_id"),
    /** How many things it stands for: a teammate's comments collapse into one row. */
    count: integer("count").notNull().default(1),
    /** The first names of the people it is about, for a collapsed row's words. */
    people: text("people").array().notNull().default(sql`'{}'::text[]`),
    /** The dedupe keys of the notifications folded into this one, so none folds in twice. */
    mergedKeys: text("merged_keys").array().notNull().default(sql`'{}'::text[]`),
    /**
     * The person's toggle for its kind was off: no banner and no push, but it is kept, and a
     * needs-you still counts on the badge.
     */
    muted: boolean("muted").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    readAt: instant("read_at"),
    readVia: text("read_via", { enum: NOTIFICATION_READ_VIA }),
    /** A needs-you whose question is closed: answered, withdrawn or cancelled. */
    resolvedAt: instant("resolved_at"),
  },
  (t) => [
    unique("notifications_user_dedupe_key").on(t.userId, t.dedupeKey),
    // What `me.notifications` watches: a person's unread rows, and their open questions.
    index("notifications_inbox_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null or (${t.kind} = 'needs_you' and ${t.resolvedAt} is null)`),
    index("notifications_canvas_kind_source_idx").on(t.canvasId, t.kind, t.sourceId),
    index("notifications_workspace_id_idx").on(t.workspaceId),
    index("notifications_created_at_idx").on(t.createdAt),
    check("notifications_kind_check", oneOf(t.kind, NOTIFICATION_KINDS)),
    check(
      "notifications_read_via_check",
      sql`(${t.readAt} is null) = (${t.readVia} is null) and (${t.readVia} is null or ${oneOf(t.readVia, NOTIFICATION_READ_VIA)})`,
    ),
    check(
      "notifications_text_check",
      sql`char_length(${t.title}) <= ${sql.raw(String(NOTIFICATION_TEXT_CHARS))} and char_length(${t.body}) <= ${sql.raw(String(NOTIFICATION_TEXT_CHARS))} and (${t.subtitle} is null or char_length(${t.subtitle}) <= ${sql.raw(String(NOTIFICATION_TEXT_CHARS))})`,
    ),
    check(
      "notifications_link_check",
      sql`jsonb_typeof(${t.link}) = 'object' and coalesce(${t.link} ->> 'open', '') in (${sql.raw(NOTIFICATION_OPENS.map((open) => `'${open}'`).join(", "))}) and ${atMostBytes(t.link, NOTIFICATION_LINK_BYTES)}`,
    ),
    check("notifications_count_check", sql`${t.count} >= 1`),
  ],
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    notificationId: text("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    /** The iPhone. Null once it is forgotten; the row stays as the record of what was sent. */
    deviceId: text("device_id").references(() => devices.id, { onDelete: "set null" }),
    state: text("state", { enum: DELIVERY_STATES }).notNull().default("waiting"),
    /** When it goes: now, or later while the person is at a Mac. */
    sendAt: instant("send_at").notNull(),
    sentAt: instant("sent_at"),
    /** Expo's ticket id, which its receipt is read by. */
    ticketId: text("ticket_id"),
    receiptCheckedAt: instant("receipt_checked_at"),
    /** Why it was cancelled (`read`, `resolved`, `pref_off`, …), or Expo's error code. */
    outcome: text("outcome"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("notification_deliveries_notification_device_key").on(t.notificationId, t.deviceId),
    index("notification_deliveries_device_id_idx").on(t.deviceId),
    // What the receipts sweep reads each minute.
    index("deliveries_receipts_idx")
      .on(t.sentAt)
      .where(sql`${t.state} = 'sent' and ${t.receiptCheckedAt} is null`),
    // What a deliver job and the sweep read: the deliveries still to send.
    index("deliveries_waiting_idx")
      .on(t.notificationId, t.sendAt)
      .where(sql`${t.state} = 'waiting'`),
    check("notification_deliveries_state_check", oneOf(t.state, DELIVERY_STATES)),
    check(
      "notification_deliveries_sent_check",
      sql`${t.state} not in ('sent', 'delivered') or (${t.sentAt} is not null and ${t.ticketId} is not null)`,
    ),
  ],
);
