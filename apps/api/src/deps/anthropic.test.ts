import { expect, test } from "bun:test";
import { FakeClock } from "@ponzu/sandbox";
import { createAnthropic } from "./anthropic.ts";

const OWN_KEY = "sk-ant-own-key-for-the-test";

/** A real client against a stand-in for Anthropic that takes only `accepted`. */
function anthropicTaking(accepted: string) {
  const asked: string[] = [];
  const anthropic = createAnthropic({
    clock: new FakeClock(Date.UTC(2026, 10, 12)),
    ownKey: OWN_KEY,
    fetch: async (_url, init) => {
      const key = new Headers(init?.headers).get("x-api-key") ?? "";
      asked.push(key);
      return new Response("{}", { status: key === accepted ? 200 : 401 });
    },
  });
  return { anthropic, asked };
}

test("the selfcheck's question asks about Ponzu's own key, and a person's key is asked as given", async () => {
  const taking = anthropicTaking(OWN_KEY);
  expect(await taking.anthropic.acceptsOwnKey()).toBe(true);
  expect(await taking.anthropic.acceptsApiKey("sk-ant-someone-else")).toBe(false);
  expect(taking.asked).toEqual([OWN_KEY, "sk-ant-someone-else"]);

  // A revoked own key is a plain no, not a failure.
  expect(await anthropicTaking("sk-ant-another").anthropic.acceptsOwnKey()).toBe(false);
});
