/*
 * Pings to phones, through the Expo push service with Expo's own server SDK (expo-server-sdk,
 * pinned exactly). This is the only file that imports the SDK (push.surface.test.ts holds it
 * to that). It is off, as `noPush`, until EXPO_ACCESS_TOKEN is set: Ponzu's Expo project turns on
 * Enhanced Security for push, so a device token that leaks is useless without this token.
 *
 * What may be logged: codes and statuses, never a device token, a message's words or the SDK's
 * own error text, which can quote tokens (PUSH_TOO_MANY_EXPERIENCE_IDS lists them). A
 * `PushError` is built from those safe parts only and carries no `cause`, so logging one, or
 * reporting it to error tracking, is safe too.
 */

import type { Clock } from "@ponzu/sandbox";
import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from "expo-server-sdk";
import type { Logger } from "../http/log.ts";

/** One ping, as Expo's send endpoint takes it (docs.expo.dev, "Message request format"). */
export interface PushMessage {
  /** An Expo push token, `ExponentPushToken[…]`, never a raw APNs token. */
  to: string;
  title?: string;
  body?: string;
  sound?: "default";
  badge?: number;
  /** Groups a canvas's pings on iOS. */
  threadId?: string;
  /** A later ping with the same id replaces this one on iOS. */
  collapseId?: string;
  priority: "high";
  interruptionLevel: "active";
  /** Seconds Expo and Apple keep trying before the ping is dropped. */
  ttl: number;
  data?: Record<string, unknown>;
}

/**
 * What Expo answered for one message, in the order they were sent. `error` is Expo's code
 * (`DeviceNotRegistered`, `MessageTooBig`, `MessageRateExceeded`, `InvalidCredentials`, …), or
 * `Unknown` when it named none.
 */
export type PushTicket = { ok: true; id: string } | { ok: false; error: string };
/** What Apple (through Expo) said about a ticket later; the same codes as a ticket's. */
export type PushReceipt = { ok: true } | { ok: false; error: string };

export interface Push {
  /** False when push is off: nothing can be sent, and a delivery is cancelled as `push_off`. */
  readonly enabled: boolean;
  /**
   * Sends at most `PUSH_SEND_LIMIT` messages in one request and answers a ticket for each, in
   * order. More is refused before anything is sent: a request is all or nothing, and a second
   * one that failed after the first went out could only be retried by sending the first again.
   * Throws `PushError` when the request as a whole failed.
   */
  send(messages: PushMessage[]): Promise<PushTicket[]>;
  /**
   * Receipts for ticket ids, as many as are asked for (read in Expo's chunks, which is safe to
   * repeat). An id with no receipt yet is missing from the answer. Throws `PushError`.
   */
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>;
}

/** The most messages one `send` takes: Expo's own limit for one request. */
export const PUSH_SEND_LIMIT = Expo.pushNotificationChunkSizeLimit;

/**
 * How long one `send` or `receipts` call may take, the SDK's own retries of a 429 included
 * (two, after one and two seconds). The SDK's `fetch` has no deadline of its own.
 */
export const PUSH_DEADLINE_MS = 20_000;

/**
 * Why a request to Expo failed as a whole:
 * - `rate_limited`: Expo answered 429, still, after the SDK's own two retries. Try later.
 * - `unavailable`: Expo answered 5xx, or never answered (the network, or the deadline). Try later.
 * - `rejected`: Expo refused the request (any other 4xx, the access token's 401 among them), or
 *   answered in a shape the SDK did not expect. Trying the same request again will not help.
 */
export type PushErrorCode = "rate_limited" | "unavailable" | "rejected";

export class PushError extends Error {
  readonly code: PushErrorCode;
  /** Expo's HTTP status, when it answered. */
  readonly status: number | null;
  /** Expo's own error code for the request (`UNAUTHORIZED`, `PUSH_TOO_MANY_EXPERIENCE_IDS`), when it named one. */
  readonly expoCode: string | null;

  constructor(code: PushErrorCode, status: number | null = null, expoCode: string | null = null) {
    super(
      `Expo push failed: ${code}${status === null ? "" : `, status ${status}`}${expoCode ? `, ${expoCode}` : ""}.`,
    );
    this.name = "PushError";
    this.code = code;
    this.status = status;
    this.expoCode = expoCode;
  }
}

/** Push while EXPO_ACCESS_TOKEN is unset: off, and anything asked of it is a caller's mistake. */
export const noPush: Push = {
  enabled: false,
  send: async () => {
    throw new Error("Push is off: EXPO_ACCESS_TOKEN is not set.");
  },
  receipts: async () => {
    throw new Error("Push is off: EXPO_ACCESS_TOKEN is not set.");
  },
};

export interface ExpoPushConfig {
  accessToken: string;
  clock: Clock;
  log: Logger;
  /** The SDK's first wait before retrying a 429, in ms. Its own default (1000) unless a test says less. */
  retryMinTimeout?: number;
}

/** Push through Expo. The SDK calls the global `fetch`; it has no way to be handed one. */
export function createExpoPush({ accessToken, clock, log, retryMinTimeout }: ExpoPushConfig): Push {
  const expo = new Expo({
    accessToken,
    maxConcurrentRequests: 2,
    ...(retryMinTimeout === undefined ? {} : { retryMinTimeout }),
  });

  /** `work`, failing as `PushError` in only the safe words, and logged by code alone. */
  async function call<T>(name: "send" | "receipts", work: () => Promise<T>): Promise<T> {
    try {
      return await withDeadline(work(), clock.timeout(PUSH_DEADLINE_MS));
    } catch (error) {
      const failure = pushErrorOf(error);
      // `failure`, not `code`: the log's redaction takes any field named `code` for a secret.
      log.warn("push_request_failed", {
        call: name,
        failure: failure.code,
        status: failure.status,
        expoCode: failure.expoCode,
      });
      throw failure;
    }
  }

  return {
    enabled: true,
    async send(messages) {
      if (messages.length > PUSH_SEND_LIMIT) {
        throw new RangeError(`Push sends at most ${PUSH_SEND_LIMIT} messages at once.`);
      }
      if (messages.length === 0) return [];
      const tickets = await call("send", () =>
        expo.sendPushNotificationsAsync(messages.map(toExpo)),
      );
      return tickets.map(fromTicket);
    },
    async receipts(ids) {
      if (ids.length === 0) return {};
      const chunks = expo.chunkPushNotificationReceiptIds(ids);
      const answers = await call("receipts", () =>
        Promise.all(chunks.map((chunk) => expo.getPushNotificationReceiptsAsync(chunk))),
      );
      const receipts: Record<string, PushReceipt> = {};
      for (const answer of answers) {
        for (const [id, receipt] of Object.entries(answer)) receipts[id] = fromReceipt(receipt);
      }
      return receipts;
    },
  };
}

/** Our message, field for field, so nothing the caller did not mean to send is sent. */
function toExpo(message: PushMessage): ExpoPushMessage {
  const out: ExpoPushMessage = {
    to: message.to,
    priority: message.priority,
    interruptionLevel: message.interruptionLevel,
    ttl: message.ttl,
  };
  if (message.title !== undefined) out.title = message.title;
  if (message.body !== undefined) out.body = message.body;
  if (message.sound !== undefined) out.sound = message.sound;
  if (message.badge !== undefined) out.badge = message.badge;
  if (message.threadId !== undefined) out.threadId = message.threadId;
  if (message.collapseId !== undefined) out.collapseId = message.collapseId;
  if (message.data !== undefined) out.data = message.data;
  return out;
}

function fromTicket(ticket: ExpoPushTicket): PushTicket {
  if (ticket.status === "ok") return { ok: true, id: ticket.id };
  return { ok: false, error: codeOf(ticket.details?.error) };
}

function fromReceipt(receipt: ExpoPushReceipt): PushReceipt {
  if (receipt.status === "ok") return { ok: true };
  return { ok: false, error: codeOf(receipt.details?.error) };
}

/** Expo's code for one message's failure, kept only if it is a code; the message beside it may quote the token. */
function codeOf(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z]{1,64}$/.test(value) ? value : "Unknown";
}

/**
 * The SDK's failure as a `PushError`. The SDK sets `statusCode` when Expo answered with an
 * error (or with `errors` in a 200), and `data` when Expo answered in the wrong shape (a ticket
 * count that does not match). Neither means a network failure; anything else thrown is one.
 */
export function pushErrorOf(error: unknown): PushError {
  if (error instanceof PushError) return error;
  const fields = (typeof error === "object" && error !== null ? error : {}) as Record<
    string,
    unknown
  >;
  const status = typeof fields.statusCode === "number" ? fields.statusCode : null;
  const expoCode =
    typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(fields.code)
      ? fields.code
      : null;
  if (status === null) {
    return new PushError("data" in fields ? "rejected" : "unavailable", null, expoCode);
  }
  if (status === 429) return new PushError("rate_limited", status, expoCode);
  if (status >= 500) return new PushError("unavailable", status, expoCode);
  return new PushError("rejected", status, expoCode);
}

/** `work`, or `unavailable` once `signal` aborts. The request itself runs on; nothing can stop it. */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const expire = () => reject(new PushError("unavailable"));
    if (signal.aborted) return expire();
    signal.addEventListener("abort", expire, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", expire);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", expire);
        reject(error);
      },
    );
  });
}
