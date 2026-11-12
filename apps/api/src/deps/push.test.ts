/*
 * createExpoPush against recorded answers in the shapes Expo documents
 * (docs.expo.dev/push-notifications/sending-notifications), served by a stubbed global `fetch`:
 * the SDK calls the global one and cannot be handed another. Nothing here reaches the network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { FakeClock } from "@ponzu/sandbox";
import { createLogger, type LogLine } from "../http/log.ts";
import { FakePush } from "../testing/fake-push.ts";
import {
  createExpoPush,
  noPush,
  PUSH_DEADLINE_MS,
  PUSH_RECEIPTS_LIMIT,
  PUSH_SEND_LIMIT,
  PushError,
  type PushMessage,
  pushErrorOf,
} from "./push.ts";

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Not a real token of anything: what the tests watch for in every log line and error. */
const ACCESS_TOKEN = "expo-access-token-under-test-4f1c9a";
const DEVICE = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
const OTHER_DEVICE = "ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

type Answer = Response | Error | "hang";

let seen: Seen[] = [];
let answers: Answer[] = [];
let logs: LogLine[] = [];
/** Requests the stub has been handed and not yet answered, and the most there ever were. */
let inFlight = 0;
let mostInFlight = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  answers = [];
  logs = [];
  inFlight = 0;
  mostInFlight = 0;
  const serve = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body as string | Uint8Array;
    const text =
      headers.get("content-encoding") === "gzip"
        ? gunzipSync(raw as Uint8Array).toString("utf8")
        : String(raw);
    seen.push({
      url: String(input),
      method: String(init?.method).toUpperCase(),
      headers,
      body: JSON.parse(text),
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("The test served no answer for this request.");
    if (answer === "hang") return new Promise<Response>(() => {});
    // Answer on a later turn, so a second request sent at once would be seen in flight.
    await Promise.resolve();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    mostInFlight = Math.max(mostInFlight, ++inFlight);
    try {
      return await serve(input, init);
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function make(clock = new FakeClock()) {
  return createExpoPush({
    accessToken: ACCESS_TOKEN,
    clock,
    log: createLogger((line) => logs.push(line)),
    // The SDK's own wait before retrying a 429; a millisecond keeps the test quick.
    retryMinTimeout: 1,
  });
}

function ping(to: string, extra: Partial<PushMessage> = {}): PushMessage {
  return {
    to,
    title: "Landing page",
    body: "Ponzu has a question for you.",
    sound: "default",
    priority: "high",
    interruptionLevel: "active",
    ttl: 3600,
    ...extra,
  };
}

/** Everything the test can see that could carry a secret: the logs, and what was thrown. */
function exposed(thrown?: unknown): string {
  const parts = [JSON.stringify(logs)];
  if (thrown instanceof Error) {
    parts.push(thrown.message, String(thrown.stack), JSON.stringify(thrown));
    parts.push(
      JSON.stringify(Object.getOwnPropertyNames(thrown).map((key) => (thrown as never)[key])),
    );
  }
  return parts.join("\n");
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("Expected the call to fail.");
}

test("a send posts the messages with the access token, and answers a ticket for each in order", async () => {
  answers.push(
    json(200, {
      data: [
        { status: "ok", id: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" },
        {
          status: "error",
          message: `"${OTHER_DEVICE}" is not a registered push notification recipient`,
          details: { error: "DeviceNotRegistered", expoPushToken: OTHER_DEVICE },
        },
      ],
    }),
  );
  const push = make();
  expect(push.enabled).toBe(true);
  const data = { v: 1, n: "ntf_1", k: "needs_you", c: "cnv_1", o: "thread" };
  const tickets = await push.send([
    ping(DEVICE, { badge: 2, threadId: "cnv_1", data }),
    ping(OTHER_DEVICE, { collapseId: "cnv_1:comments" }),
  ]);
  expect(tickets).toEqual([
    { ok: true, id: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" },
    { ok: false, error: "DeviceNotRegistered" },
  ]);
  // Expo's per-message words quote the device token; only its code is kept.
  expect(JSON.stringify(tickets)).not.toContain("yyyy");

  expect(seen).toHaveLength(1);
  const [request] = seen;
  expect(request!.url).toBe(SEND_URL);
  expect(request!.method).toBe("POST");
  expect(request!.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(request!.headers.get("content-type")).toBe("application/json");
  // Exactly the fields asked for, and nothing else.
  expect(request!.body).toEqual([
    {
      to: DEVICE,
      title: "Landing page",
      body: "Ponzu has a question for you.",
      sound: "default",
      badge: 2,
      threadId: "cnv_1",
      priority: "high",
      interruptionLevel: "active",
      ttl: 3600,
      data,
    },
    {
      to: OTHER_DEVICE,
      title: "Landing page",
      body: "Ponzu has a question for you.",
      sound: "default",
      collapseId: "cnv_1:comments",
      priority: "high",
      interruptionLevel: "active",
      ttl: 3600,
    },
  ]);
  expect(logs).toEqual([]);
});

test("a badge-only message carries no words", async () => {
  answers.push(json(200, { data: [{ status: "ok", id: "r1" }] }));
  await make().send([
    { to: DEVICE, badge: 0, priority: "high", interruptionLevel: "active", ttl: 3600 },
  ]);
  expect(seen[0]!.body).toEqual([
    { to: DEVICE, badge: 0, priority: "high", interruptionLevel: "active", ttl: 3600 },
  ]);
});

test("every ticket error code Expo documents is kept, and anything that is not a code is Unknown", async () => {
  const codes = [
    "DeviceNotRegistered",
    "MessageTooBig",
    "MessageRateExceeded",
    "InvalidCredentials",
  ];
  answers.push(
    json(200, {
      data: [
        ...codes.map((error) => ({ status: "error", message: "words", details: { error } })),
        { status: "error", message: "no details at all" },
        { status: "error", message: "odd", details: { error: `${DEVICE} quoted` } },
      ],
    }),
  );
  const tickets = await make().send(Array.from({ length: 6 }, () => ping(DEVICE)));
  expect(tickets).toEqual([
    ...codes.map((error) => ({ ok: false as const, error })),
    { ok: false, error: "Unknown" },
    { ok: false, error: "Unknown" },
  ]);
});

test("one send takes at most 100 messages, sent in one gzipped request", async () => {
  const hundred = Array.from({ length: PUSH_SEND_LIMIT }, (_, index) =>
    ping(`ExponentPushToken[${String(index).padStart(22, "0")}]`),
  );
  answers.push(json(200, { data: hundred.map((_, index) => ({ status: "ok", id: `r${index}` })) }));
  const tickets = await make().send(hundred);
  expect(PUSH_SEND_LIMIT).toBe(100);
  expect(tickets).toHaveLength(100);
  expect(tickets[99]).toEqual({ ok: true, id: "r99" });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.headers.get("content-encoding")).toBe("gzip");
  expect((seen[0]!.body as unknown[]).length).toBe(100);

  // A hundred and one is the caller's mistake, refused before anything goes out.
  const refused = await failure(make().send([...hundred, ping(DEVICE)]));
  expect(refused).toBeInstanceOf(RangeError);
  expect(seen).toHaveLength(1);
});

test("nothing to send or read makes no request", async () => {
  const push = make();
  expect(await push.send([])).toEqual([]);
  expect(await push.receipts([])).toEqual({});
  expect(seen).toEqual([]);
});

test("a 429 is tried twice more by the SDK, and the third answer is what counts", async () => {
  const limited = () =>
    json(429, { errors: [{ code: "TOO_MANY_REQUESTS", message: "Slow down." }] });
  answers.push(limited(), limited(), json(200, { data: [{ status: "ok", id: "r1" }] }));
  expect(await make().send([ping(DEVICE)])).toEqual([{ ok: true, id: "r1" }]);
  expect(seen).toHaveLength(3);
  expect(logs).toEqual([]);
});

test("a 429 three times over is rate_limited", async () => {
  for (let i = 0; i < 3; i++) {
    answers.push(json(429, { errors: [{ code: "TOO_MANY_REQUESTS", message: "Slow down." }] }));
  }
  const thrown = await failure(make().send([ping(DEVICE)]));
  expect(thrown).toBeInstanceOf(PushError);
  expect((thrown as PushError).code).toBe("rate_limited");
  expect((thrown as PushError).status).toBe(429);
  expect(seen).toHaveLength(3);
  expect(logs).toEqual([
    {
      level: "warn",
      event: "push_request_failed",
      call: "send",
      failure: "rate_limited",
      status: 429,
      expoCode: "TOO_MANY_REQUESTS",
    },
  ]);
});

test("a 500 is unavailable, and is not retried inside", async () => {
  answers.push(new Response("upstream fell over", { status: 500 }));
  const thrown = (await failure(make().send([ping(DEVICE)]))) as PushError;
  expect(thrown.code).toBe("unavailable");
  expect(thrown.status).toBe(500);
  expect(seen).toHaveLength(1);
  // Expo's own text is not carried.
  expect(exposed(thrown)).not.toContain("fell over");
});

test("a network failure is unavailable", async () => {
  answers.push(new TypeError("fetch failed"));
  const thrown = (await failure(make().send([ping(DEVICE)]))) as PushError;
  expect(thrown).toBeInstanceOf(PushError);
  expect(thrown.code).toBe("unavailable");
  expect(thrown.status).toBeNull();
});

test("Expo that never answers is unavailable at the deadline", async () => {
  const clock = new FakeClock();
  answers.push("hang");
  const pending = failure(make(clock).send([ping(DEVICE)]));
  // Let the SDK reach fetch, then let the deadline pass.
  await Promise.resolve();
  clock.advance(PUSH_DEADLINE_MS);
  const thrown = (await pending) as PushError;
  expect(thrown.code).toBe("unavailable");
  expect(thrown.status).toBeNull();
});

test("a 401 for the access token is rejected, and nothing it quotes is logged or thrown", async () => {
  answers.push(
    json(401, {
      errors: [
        {
          code: "UNAUTHORIZED",
          message: `The bearer token ${ACCESS_TOKEN} is invalid for push to ${DEVICE}.`,
        },
      ],
    }),
  );
  const thrown = (await failure(make().send([ping(DEVICE)]))) as PushError;
  expect(thrown.code).toBe("rejected");
  expect(thrown.status).toBe(401);
  expect(thrown.expoCode).toBe("UNAUTHORIZED");
  expect(thrown.cause).toBeUndefined();
  const text = exposed(thrown);
  expect(text).not.toContain(ACCESS_TOKEN);
  expect(text).not.toContain("xxxx");
  expect(text).not.toContain("invalid for push");
});

test("an error that echoes device tokens (PUSH_TOO_MANY_EXPERIENCE_IDS) reaches no log", async () => {
  answers.push(
    json(400, {
      errors: [
        {
          code: "PUSH_TOO_MANY_EXPERIENCE_IDS",
          message: `All push notification messages in the same request must be for the same project; ${DEVICE} and ${OTHER_DEVICE} are not.`,
          details: { "@north-brook/ponzu": [DEVICE], "@someone/else": [OTHER_DEVICE] },
        },
      ],
    }),
  );
  const thrown = (await failure(make().send([ping(DEVICE), ping(OTHER_DEVICE)]))) as PushError;
  expect(thrown.code).toBe("rejected");
  expect(thrown.status).toBe(400);
  expect(thrown.expoCode).toBe("PUSH_TOO_MANY_EXPERIENCE_IDS");
  const text = exposed(thrown);
  expect(text).not.toContain("xxxx");
  expect(text).not.toContain("yyyy");
  expect(text).not.toContain("north-brook");
  expect(text).not.toContain(ACCESS_TOKEN);
  expect(logs).toHaveLength(1);
});

test("an answer in the wrong shape is rejected, not retried as unavailable", async () => {
  // One ticket for two messages: the SDK refuses it, and sending again could ping twice.
  answers.push(json(200, { data: [{ status: "ok", id: "r1" }] }));
  const thrown = (await failure(make().send([ping(DEVICE), ping(OTHER_DEVICE)]))) as PushError;
  expect(thrown.code).toBe("rejected");
  expect(thrown.status).toBeNull();
});

test("a ticket in the wrong shape is rejected and logged, not read as a success or a failed ping", async () => {
  const malformed = [
    { status: "ok" },
    { status: "ok", id: 7 },
    { status: "ok", id: `${DEVICE} quoted` },
    { status: "queued", id: "r1" },
    null,
  ];
  for (const ticket of malformed) {
    logs = [];
    answers.push(json(200, { data: [ticket] }));
    const thrown = (await failure(make().send([ping(DEVICE)]))) as PushError;
    expect(thrown).toBeInstanceOf(PushError);
    expect(thrown.code).toBe("rejected");
    expect(exposed(thrown)).not.toContain("xxxx");
    expect(logs).toEqual([
      {
        level: "warn",
        event: "push_request_failed",
        call: "send",
        failure: "rejected",
        status: null,
        expoCode: null,
      },
    ]);
  }
});

test("receipts come back as a map, a missing id is not yet settled, and error words are dropped", async () => {
  answers.push(
    json(200, {
      data: {
        r1: { status: "ok" },
        r2: {
          status: "error",
          message: `"${DEVICE}" is not a registered push notification recipient`,
          details: { error: "DeviceNotRegistered", expoPushToken: DEVICE },
        },
        r3: { status: "error", message: "Too big", details: { error: "MessageTooBig" } },
      },
    }),
  );
  const receipts = await make().receipts(["r1", "r2", "r3", "r4"]);
  expect(receipts).toEqual({
    r1: { ok: true },
    r2: { ok: false, error: "DeviceNotRegistered" },
    r3: { ok: false, error: "MessageTooBig" },
  });
  expect(JSON.stringify(receipts)).not.toContain("xxxx");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe(RECEIPTS_URL);
  expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  expect(seen[0]!.body).toEqual({ ids: ["r1", "r2", "r3", "r4"] });
});

test("more than 300 receipt ids are read in Expo's chunks and merged", async () => {
  const ids = Array.from({ length: 301 }, (_, index) => `r${index}`);
  answers.push(
    json(200, { data: { r0: { status: "ok" } } }),
    json(200, { data: { r300: { status: "ok" } } }),
  );
  expect(await make().receipts(ids)).toEqual({ r0: { ok: true }, r300: { ok: true } });
  expect(seen.map((request) => (request.body as { ids: string[] }).ids.length)).toEqual([300, 1]);
  // One after another: the SDK holds receipt requests to no concurrency limit of its own.
  expect(mostInFlight).toBe(1);
});

test("one receipts call takes at most 1000 ids, and more is refused before anything is asked", async () => {
  expect(PUSH_RECEIPTS_LIMIT).toBe(1000);
  const ids = Array.from({ length: PUSH_RECEIPTS_LIMIT + 1 }, (_, index) => `r${index}`);
  expect(await failure(make().receipts(ids))).toBeInstanceOf(RangeError);
  expect(await failure(new FakePush().receipts(ids))).toBeInstanceOf(RangeError);
  expect(seen).toEqual([]);
});

test("a receipt that is not a receipt is left out, as one not settled yet", async () => {
  answers.push(json(200, { data: { r1: null, r2: "ok", r3: { status: "ok" } } }));
  expect(await make().receipts(["r1", "r2", "r3"])).toEqual({ r3: { ok: true } });
});

test("the SDK's own error text, which quotes what Expo said, reaches no log and no error", async () => {
  // A 502 from a proxy with an HTML page, which the SDK copies whole into its message and errorText.
  answers.push(new Response(`<html>bad gateway for ${DEVICE}</html>`, { status: 502 }));
  const thrown = (await failure(make().send([ping(DEVICE)]))) as PushError;
  expect(thrown.code).toBe("unavailable");
  expect(thrown.status).toBe(502);
  const text = exposed(thrown);
  expect(text).not.toContain("bad gateway");
  expect(text).not.toContain("xxxx");
  expect(logs).toEqual([
    {
      level: "warn",
      event: "push_request_failed",
      call: "send",
      failure: "unavailable",
      status: 502,
      expoCode: null,
    },
  ]);
});

test("a receipts request that fails maps the same way as a send's", async () => {
  answers.push(json(503, { errors: [{ code: "INTERNAL_SERVER_ERROR", message: "Try later." }] }));
  const thrown = (await failure(make().receipts(["r1"]))) as PushError;
  expect(thrown.code).toBe("unavailable");
  expect(thrown.status).toBe(503);
  expect(logs).toEqual([
    {
      level: "warn",
      event: "push_request_failed",
      call: "receipts",
      failure: "unavailable",
      status: 503,
      expoCode: "INTERNAL_SERVER_ERROR",
    },
  ]);
});

test("the status of a failure decides its code", () => {
  const withStatus = (statusCode: number, code?: string) =>
    Object.assign(new Error("words"), { statusCode, code });
  expect(pushErrorOf(withStatus(429)).code).toBe("rate_limited");
  expect(pushErrorOf(withStatus(500)).code).toBe("unavailable");
  expect(pushErrorOf(withStatus(502)).code).toBe("unavailable");
  expect(pushErrorOf(withStatus(599)).code).toBe("unavailable");
  expect(pushErrorOf(withStatus(400)).code).toBe("rejected");
  expect(pushErrorOf(withStatus(401, "UNAUTHORIZED")).code).toBe("rejected");
  expect(pushErrorOf(withStatus(403)).code).toBe("rejected");
  expect(pushErrorOf(withStatus(413)).code).toBe("rejected");
  expect(pushErrorOf(new TypeError("fetch failed")).code).toBe("unavailable");
  expect(pushErrorOf("a string").code).toBe("unavailable");
  expect(pushErrorOf(null).code).toBe("unavailable");
  // A code is kept only if it looks like one of Expo's, never as free text.
  expect(pushErrorOf(withStatus(400, `bad ${DEVICE}`)).expoCode).toBeNull();
  const same = new PushError("rejected", 401);
  expect(pushErrorOf(same)).toBe(same);
});

test("noPush is off, and asking it to send is a mistake", async () => {
  expect(noPush.enabled).toBe(false);
  expect(await failure(noPush.send([ping(DEVICE)]))).toBeInstanceOf(Error);
  expect(await failure(noPush.receipts(["r1"]))).toBeInstanceOf(Error);
  expect(seen).toEqual([]);
});

test("FakePush records messages and answers scripted tickets, failures and receipts", async () => {
  const fake = new FakePush();
  fake.answerNext({ ok: false, error: "DeviceNotRegistered" });
  expect(await fake.send([ping(DEVICE), ping(OTHER_DEVICE)])).toEqual([
    { ok: false, error: "DeviceNotRegistered" },
    { ok: true, id: "tkt_1" },
  ]);
  expect(fake.sent.map((message) => message.to)).toEqual([DEVICE, OTHER_DEVICE]);

  fake.failNext("rate_limited");
  const thrown = (await failure(fake.send([ping(DEVICE)]))) as PushError;
  expect(thrown.code).toBe("rate_limited");
  expect(fake.sent).toHaveLength(2);

  fake.settle("tkt_1", { ok: true });
  expect(await fake.receipts(["tkt_1", "tkt_2"])).toEqual({ tkt_1: { ok: true } });
  expect(fake.receiptRequests).toEqual([["tkt_1", "tkt_2"]]);

  expect(await failure(fake.send(Array.from({ length: 101 }, () => ping(DEVICE))))).toBeInstanceOf(
    RangeError,
  );
  const off = new FakePush({ enabled: false });
  expect(off.enabled).toBe(false);
  expect(await failure(off.send([ping(DEVICE)]))).toBeInstanceOf(Error);
});
