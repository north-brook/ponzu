/*
 * createResendMail against recorded answers in the shapes Resend documents
 * (resend.com/docs/api-reference/emails/send-email, and its errors page), served by a stubbed
 * global `fetch`: the SDK calls the global one and cannot be handed another. Nothing here reaches
 * the network.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { createLogger, type LogLine } from "../http/log.ts";
import { FakeMail } from "../testing/fake-mail.ts";
import {
  createResendMail,
  MAIL_DEADLINE_MS,
  MailError,
  type MailMessage,
  mailErrorOf,
  noMail,
} from "./mail.ts";

/** Not a real key of anything: what the tests watch for in every log line and error. */
const API_KEY = "re_test_key_under_test_7d2f";
const ADDRESS = "maya@example.com";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Answer = Response | Error | "hang";

let seen: Seen[] = [];
let answers: Answer[] = [];
let logs: LogLine[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  answers = [];
  logs = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: String(init?.method).toUpperCase(),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("The test served no answer for this request.");
    if (answer === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const clock = new FakeClock();
const mail = () =>
  createResendMail({
    apiKey: API_KEY,
    from: "Ponzu <ping@ponzu.design>",
    clock,
    log: createLogger((line) => logs.push(line)),
  });

const message: MailMessage = {
  to: ADDRESS,
  subject: "Ponzu: 1 thing on 1 canvas",
  html: "<p>Ponzu has a question for you.</p>",
  text: "Ponzu has a question for you.",
  headers: {
    "List-Unsubscribe": "<https://api.test/v1/email/unsubscribe?t=x>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  },
  idempotencyKey: "digest:usr_1:2026-01-01",
};

/** What a failed send threw, after checking it said nothing it should not. */
async function failure(): Promise<MailError> {
  const thrown = await mail()
    .send(message)
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(thrown).toBeInstanceOf(MailError);
  const said = `${(thrown as Error).message} ${JSON.stringify(logs)}`;
  expect(said).not.toContain(API_KEY);
  expect(said).not.toContain(ADDRESS);
  return thrown as MailError;
}

test("sends one email to Resend with the key, the idempotency key and every part", async () => {
  answers.push(json(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }));
  expect(await mail().send(message)).toEqual({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
  expect(seen).toHaveLength(1);
  const [request] = seen;
  expect(request!.url).toBe("https://api.resend.com/emails");
  expect(request!.method).toBe("POST");
  expect(request!.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  expect(request!.headers.get("idempotency-key")).toBe("digest:usr_1:2026-01-01");
  expect(request!.body).toEqual({
    from: "Ponzu <ping@ponzu.design>",
    to: ADDRESS,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
  });
  expect(logs).toEqual([]);
});

test("Reply-To and tags go as Resend's reply_to and tags; none are sent when there are none", async () => {
  answers.push(json(200, { id: "5e4d5e4d-0000-4000-8000-000000000001" }));
  await mail().send({
    ...message,
    replyTo: "hello@ponzu.design",
    tags: [
      { name: "kind", value: "billing" },
      { name: "env", value: "dev" },
    ],
  });
  expect(seen[0]!.body).toEqual({
    from: "Ponzu <ping@ponzu.design>",
    to: ADDRESS,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
    reply_to: "hello@ponzu.design",
    tags: [
      { name: "kind", value: "billing" },
      { name: "env", value: "dev" },
    ],
  });
  // The first test pins the body with neither: no `reply_to: undefined`, no empty `tags`.
  answers.push(json(200, { id: "5e4d5e4d-0000-4000-8000-000000000002" }));
  await mail().send({ ...message, tags: [] });
  expect(Object.keys(seen[1]!.body)).not.toContain("tags");
  expect(Object.keys(seen[1]!.body)).not.toContain("reply_to");
});

test("a tag Resend would refuse is refused before anything is sent", async () => {
  for (const tag of [
    { name: "kind", value: "a b" },
    { name: "kínd", value: "x" },
    { name: "", value: "x" },
  ]) {
    await expect(mail().send({ ...message, tags: [tag] })).rejects.toThrow("A Resend tag");
  }
  expect(seen).toEqual([]);
});

test("Resend's errors become codes, with nothing they quote", async () => {
  const cases: [Answer, MailError["code"], number | null, string | null][] = [
    [
      json(429, {
        statusCode: 429,
        name: "rate_limit_exceeded",
        message: `Too many for ${ADDRESS}`,
      }),
      "rate_limited",
      429,
      "rate_limit_exceeded",
    ],
    [
      json(429, { statusCode: 429, name: "daily_quota_exceeded", message: "quota" }),
      "rate_limited",
      429,
      "daily_quota_exceeded",
    ],
    [
      json(422, { statusCode: 422, name: "validation_error", message: `Invalid to: ${ADDRESS}` }),
      "rejected",
      422,
      "validation_error",
    ],
    // Resend's answer to a key restricted to another domain, or a test address it refuses.
    [
      json(403, {
        statusCode: 403,
        name: "validation_error",
        message: `You can only send testing emails to your own address, not ${ADDRESS}`,
      }),
      "rejected",
      403,
      "validation_error",
    ],
    [
      json(403, { statusCode: 403, name: "invalid_from_address", message: "domain" }),
      "rejected",
      403,
      "invalid_from_address",
    ],
    [
      json(409, { statusCode: 409, name: "invalid_idempotent_request", message: "same key" }),
      "duplicate",
      409,
      "invalid_idempotent_request",
    ],
    [
      json(409, { statusCode: 409, name: "concurrent_idempotent_requests", message: "wait" }),
      "unavailable",
      409,
      "concurrent_idempotent_requests",
    ],
    [
      json(500, { statusCode: 500, name: "internal_server_error", message: "oops" }),
      "unavailable",
      500,
      "internal_server_error",
    ],
    // A body that is not JSON: the SDK names it application_error, with the status.
    [
      new Response("<html>Bad gateway</html>", { status: 502 }),
      "unavailable",
      502,
      "application_error",
    ],
    // The network.
    [new TypeError("fetch failed"), "unavailable", null, "application_error"],
    // A 200 in a shape that has no id.
    [json(200, { object: "email" }), "rejected", null, null],
  ];
  for (const [answer, code, status, resendCode] of cases) {
    logs = [];
    answers.push(answer);
    const thrown = await failure();
    expect({ code: thrown.code, status: thrown.status, resendCode: thrown.resendCode }).toEqual({
      code,
      status,
      resendCode,
    });
    expect(logs).toMatchObject([
      { level: "warn", event: "mail_send_failed", failure: code, status, resendCode },
    ]);
  }
});

test("a send nobody answers fails as unavailable at the deadline", async () => {
  answers.push("hang");
  const pending = mail()
    .send(message)
    .then(
      () => null,
      (error: unknown) => error,
    );
  // Let the request start before the clock moves.
  await Promise.resolve();
  await Promise.resolve();
  clock.advance(MAIL_DEADLINE_MS);
  const thrown = (await pending) as MailError;
  expect(thrown).toBeInstanceOf(MailError);
  expect(thrown.code).toBe("unavailable");
});

test("off without a key: noMail sends nothing", async () => {
  expect(noMail.enabled).toBe(false);
  await expect(noMail.send(message)).rejects.toThrow("Email is off");
  expect(seen).toEqual([]);
});

test("mailErrorOf reads only a status and a plain name", () => {
  expect(mailErrorOf({ statusCode: 401, name: "missing_api_key", message: API_KEY })).toMatchObject(
    {
      code: "rejected",
      status: 401,
      resendCode: "missing_api_key",
    },
  );
  expect(mailErrorOf({ statusCode: 400, name: `not a name ${ADDRESS}` }).resendCode).toBeNull();
  expect(mailErrorOf(null).code).toBe("rejected");
});

test("FakeMail answers a repeated key as Resend does", async () => {
  const fake = new FakeMail();
  const first = await fake.send(message);
  expect(await fake.send(message)).toEqual(first);
  expect(fake.sent).toHaveLength(1);
  await expect(fake.send({ ...message, text: "Something else." })).rejects.toMatchObject({
    code: "duplicate",
  });
  fake.failNext("rate_limited");
  await expect(fake.send({ ...message, idempotencyKey: "other" })).rejects.toMatchObject({
    code: "rate_limited",
  });
  await expect(new FakeMail({ enabled: false }).send(message)).rejects.toThrow("Email is off");
});
