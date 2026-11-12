import { expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { FakePosthogAdmin } from "../testing/fake-posthog-admin.ts";
import { bulkDeleteBody, createPosthogAdmin, type PosthogAdminError } from "./posthog-admin.ts";

// The real PostHog admin client against the in-memory PostHog: exactly what it sends, and what
// it makes of each answer.

function setUp() {
  const posthog = new FakePosthogAdmin();
  const clock = new FakeClock();
  const admin = createPosthogAdmin({ config: posthog.config, fetch: posthog.fetch, clock });
  return { posthog, admin, clock };
}

test("it posts exactly PostHog's bulk delete for one distinct id, with the personal key", async () => {
  const { posthog, admin } = setUp();
  posthog.people.add("usr_rae");
  await admin.forgetPerson("usr_rae");
  expect(posthog.requests).toEqual([
    {
      method: "POST",
      url: "https://posthog.test/api/projects/4242/persons/bulk_delete/",
      authorization: "Bearer phx_fake_personal_api_key_0000000000",
      body: { distinct_ids: ["usr_rae"], delete_events: true, delete_recordings: true },
    },
  ]);
  expect(bulkDeleteBody("usr_x")).toEqual({
    distinct_ids: ["usr_x"],
    delete_events: true,
    delete_recordings: true,
  });
  expect(posthog.forgotten).toEqual(["usr_rae"]);
  expect(posthog.people.has("usr_rae")).toBe(false);
});

test("a person PostHog never had is done: 202 with nobody found", async () => {
  const { posthog, admin } = setUp();
  await admin.forgetPerson("usr_nobody");
  expect(posthog.forgotten).toEqual(["usr_nobody"]);
});

test("a 202 with no body is done, as PostHog's older answer was", async () => {
  const { posthog, admin } = setUp();
  posthog.answerNext({ status: 202, body: null });
  await admin.forgetPerson("usr_rae");
});

test("a 5xx, a refused key and deletion errors each throw, naming only the status", async () => {
  const { posthog, admin } = setUp();
  posthog.answerNext(
    { status: 503 },
    { status: 401, body: { detail: "phx_fake_personal_api_key_0000000000 is not valid" } },
    { status: 202, body: { persons_found: 1, deletion_errors: [{ distinct_id: "usr_rae" }] } },
  );
  const failures: PosthogAdminError[] = [];
  for (let i = 0; i < 3; i++) {
    try {
      await admin.forgetPerson("usr_rae");
    } catch (error) {
      failures.push(error as PosthogAdminError);
    }
  }
  expect(failures.map((error) => [error.name, error.status, error.message])).toEqual([
    ["PosthogAdminError", 503, "POST persons/bulk_delete answered 503"],
    ["PosthogAdminError", 401, "POST persons/bulk_delete answered 401"],
    ["PosthogAdminError", 202, "POST persons/bulk_delete answered 202 with 1 deletion errors"],
  ]);
  for (const error of failures) expect(String(error)).not.toContain("phx_");
});

test("no answer throws, and the call has ten seconds", async () => {
  const clock = new FakeClock();
  let signal: AbortSignal | undefined;
  const admin = createPosthogAdmin({
    config: new FakePosthogAdmin().config,
    clock,
    fetch: (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }),
      );
    },
  });
  const pending = admin.forgetPerson("usr_rae");
  clock.advance(9_999);
  expect(signal?.aborted).toBe(false);
  clock.advance(1);
  await expect(pending).rejects.toThrow("POST persons/bulk_delete did not answer");
});
