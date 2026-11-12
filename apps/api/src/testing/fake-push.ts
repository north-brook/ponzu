import {
  PUSH_RECEIPTS_LIMIT,
  PUSH_SEND_LIMIT,
  type Push,
  PushError,
  type PushMessage,
  type PushReceipt,
  type PushTicket,
} from "../deps/push.ts";

/**
 * Push in memory. It records every message sent and answers each with a ticket: the next one
 * scripted with `answerNext`, or `ok` with a fresh id. A receipt is whatever `settle` set for
 * that ticket id, and missing until then, as Expo's are. `failNext` makes the next calls throw
 * a `PushError`, as a 429 or a 5xx from Expo would. `enabled: false` acts out push being off.
 */
export class FakePush implements Push {
  readonly enabled: boolean;
  /** Every message sent, oldest first. */
  readonly sent: PushMessage[] = [];
  /** Every id list `receipts` was asked for, oldest first. */
  readonly receiptRequests: string[][] = [];
  readonly #tickets: PushTicket[] = [];
  readonly #failures: PushError[] = [];
  readonly #receipts = new Map<string, PushReceipt>();
  #next = 0;

  constructor({ enabled = true }: { enabled?: boolean } = {}) {
    this.enabled = enabled;
  }

  /** The tickets the next messages get, in order, before falling back to `ok`. */
  answerNext(...tickets: PushTicket[]): void {
    this.#tickets.push(...tickets);
  }

  /** The next calls (send or receipts), one each, throw these codes. */
  failNext(...codes: PushError["code"][]): void {
    this.#failures.push(...codes.map((code) => new PushError(code)));
  }

  /** What `receipts` answers for a ticket id from now on. */
  settle(id: string, receipt: PushReceipt): void {
    this.#receipts.set(id, receipt);
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    if (!this.enabled) throw new Error("Push is off: EXPO_ACCESS_TOKEN is not set.");
    if (messages.length > PUSH_SEND_LIMIT) {
      throw new RangeError(`Push sends at most ${PUSH_SEND_LIMIT} messages at once.`);
    }
    const failure = this.#failures.shift();
    if (failure) throw failure;
    this.sent.push(...messages.map((message) => structuredClone(message)));
    return messages.map(() => this.#tickets.shift() ?? { ok: true, id: `tkt_${++this.#next}` });
  }

  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    if (!this.enabled) throw new Error("Push is off: EXPO_ACCESS_TOKEN is not set.");
    if (ids.length > PUSH_RECEIPTS_LIMIT) {
      throw new RangeError(`Push reads at most ${PUSH_RECEIPTS_LIMIT} receipts at once.`);
    }
    this.receiptRequests.push([...ids]);
    const failure = this.#failures.shift();
    if (failure) throw failure;
    const answer: Record<string, PushReceipt> = {};
    for (const id of ids) {
      const receipt = this.#receipts.get(id);
      if (receipt) answer[id] = receipt;
    }
    return answer;
  }
}
