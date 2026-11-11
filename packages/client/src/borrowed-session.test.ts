import { expect, test } from "bun:test";
import { borrowSession, type SessionLender } from "./borrowed-session.ts";
import { ApiError } from "./errors.ts";
import type { SessionState } from "./session.ts";

const user = { id: "usr_1", githubLogin: "maya", name: "Maya", email: null, avatarUrl: null };
const client = { platform: "macos", version: "2.0.0" };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A holder that lends `at_<n>`, and a fresh one whenever the last is turned down. */
function lender(first: SessionState = { status: "signed_in", user }) {
  const listeners = new Set<(state: SessionState) => void>();
  const asked: (string | undefined)[] = [];
  const reported: string[] = [];
  let issued = 0;
  const holder: SessionLender = {
    getState: async () => first,
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async accessToken(rejected) {
      asked.push(rejected);
      if (rejected === `at_${issued}`) issued++;
      return `at_${issued}`;
    },
    report: (error) => reported.push(error.code),
    signOut: async () => {},
  };
  const say = (state: SessionState) => {
    for (const listener of listeners) listener(state);
  };
  return { holder, asked, reported, say };
}

test("takes its state from the holder, and hears it change", async () => {
  const { holder, say } = lender();
  const session = borrowSession({ apiUrl: "https://api.test/", client, lender: holder });
  expect(session.apiUrl).toBe("https://api.test");
  expect(session.getState()).toEqual({ status: "loading" });
  const changes: string[] = [];
  session.subscribe(() => changes.push(session.getState().status));
  await Promise.resolve();
  expect(session.getState()).toEqual({ status: "signed_in", user });
  say({ status: "signed_out" });
  expect(changes).toEqual(["signed_in", "signed_out"]);
});

test("a state announced before the first answer is not overwritten by that answer", async () => {
  const { holder, say } = lender();
  const session = borrowSession({ apiUrl: "https://api.test", client, lender: holder });
  say({ status: "signed_out" });
  await Promise.resolve();
  await Promise.resolve();
  expect(session.getState()).toEqual({ status: "signed_out" });
});

test("sends a borrowed bearer and the client header, and borrows a fresh one once on expiry", async () => {
  const { holder, asked } = lender();
  const seen: { auth: string | null; client: string | null }[] = [];
  const session = borrowSession({
    apiUrl: "https://api.test",
    client,
    lender: holder,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        auth: request.headers.get("authorization"),
        client: request.headers.get("x-ponzu-client"),
      });
      return seen.length === 1
        ? json(401, { error: { code: "token_expired", message: "Expired." } })
        : json(200, { ok: true });
    },
  });
  const response = await session.fetch("https://api.test/v1/me");
  expect(await response.json()).toEqual({ ok: true });
  expect(seen).toEqual([
    { auth: "Bearer at_0", client: "macos/2.0.0" },
    { auth: "Bearer at_1", client: "macos/2.0.0" },
  ]);
  expect(asked).toEqual([undefined, "at_0"]);
});

test("hands each error to the holder before throwing it", async () => {
  const { holder, reported } = lender();
  const session = borrowSession({
    apiUrl: "https://api.test",
    client,
    lender: holder,
    fetch: async () =>
      json(426, {
        error: { code: "client_too_old", message: "Update.", details: { minimumVersion: "2.1.0" } },
      }),
  });
  const error = await session.fetch("https://api.test/v1/me").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe("client_too_old");
  expect(reported).toEqual(["client_too_old"]);
});

test("never signs in itself: its holder does", async () => {
  const { holder } = lender();
  const session = borrowSession({ apiUrl: "https://api.test", client, lender: holder });
  await expect(session.completeSignIn({ code: "c", codeVerifier: "v" })).rejects.toThrow(
    "borrowed",
  );
});
