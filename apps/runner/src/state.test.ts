import { expect, test } from "bun:test";
import type { RunnerApi } from "./api/api.ts";
import type { ClaudeLimitReport, StateRequest } from "./api/protocol.ts";
import { StateReporter } from "./state.ts";

const REJECTED: ClaudeLimitReport = {
  status: "rejected",
  window: "five_hour",
  resetsAt: "2026-11-12T21:00:00.000Z",
  utilization: 1,
};
const ALLOWED: ClaudeLimitReport = { ...REJECTED, status: "allowed", utilization: 0.4 };

/** A runner API whose state calls answer only when the test lets them. */
function held() {
  const sent: StateRequest[] = [];
  const waiting: Array<{ answer(): void; fail(err: unknown): void }> = [];
  let arrived: (() => void) | null = null;
  /** Once set, calls answer at once: what the reporter's last send on `stop` needs. */
  const open = { now: false };
  const api = {
    putState(state: StateRequest) {
      sent.push(state);
      arrived?.();
      if (open.now) return Promise.resolve({ seq: sent.length });
      return new Promise((resolve, reject) => {
        waiting.push({ answer: () => resolve({ seq: sent.length }), fail: reject });
      });
    },
  } as unknown as RunnerApi;
  /** Resolves once `n` state calls have been made. */
  const calls = (n: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (sent.length >= n) {
          arrived = null;
          resolve();
        } else arrived = check;
      };
      check();
    });
  const limits = () => sent.flatMap((s) => (s.claudeLimit ? [s.claudeLimit] : []));
  /** Answer every call from now on, and stop the reporter. */
  const stop = (r: StateReporter) => {
    open.now = true;
    for (const w of waiting.splice(0)) w.answer();
    return r.stop();
  };
  return { api, sent, waiting, calls, limits, stop };
}

const reporter = (api: RunnerApi) =>
  new StateReporter(api, { gapMs: 0, heartbeatMs: 60_000, onSeq: () => {}, backoff: () => 0 });

test("a limit that changes back while its report travels is still said", async () => {
  const h = held();
  const r = reporter(h.api);
  r.limit(ALLOWED);
  await h.calls(1);
  h.waiting[0]!.answer();
  // The plan reached its limit, and that report is on its way.
  r.limit(REJECTED);
  await h.calls(2);
  // It lifted again before the API answered: the same as the last that landed, but not as
  // what the API will hold once this report lands.
  r.limit(ALLOWED);
  h.waiting[1]!.answer();
  await h.calls(3);
  h.waiting[2]!.answer();
  await h.stop(r);
  expect(h.limits()).toEqual([ALLOWED, REJECTED, ALLOWED]);
});

test("news the same as the report in flight is not said twice", async () => {
  const h = held();
  const r = reporter(h.api);
  r.limit(REJECTED);
  await h.calls(1);
  r.limit({ ...REJECTED });
  h.waiting[0]!.answer();
  await h.stop(r);
  expect(h.limits()).toEqual([REJECTED]);
});

test("a report that did not get through goes again", async () => {
  const h = held();
  const r = reporter(h.api);
  r.limit(REJECTED);
  await h.calls(1);
  // The same news while it travels is dropped, since the report in flight carries it.
  r.limit({ ...REJECTED });
  h.waiting[0]!.fail(new Error("offline"));
  await h.calls(2);
  h.waiting[1]!.answer();
  await h.stop(r);
  expect(h.limits()).toEqual([REJECTED, REJECTED]);
});
