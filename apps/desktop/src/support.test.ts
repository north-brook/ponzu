import { expect, test } from "bun:test";
import { scrubSecretsText } from "@ponzu/client";
import { HELP_LINKS, requestIdOf, SUPPORT_EMAIL, supportBody, supportMailto } from "./support.ts";

const facts = {
  version: "2.0.0",
  commit: "abc1234def5678",
  environment: "production",
  lastRequestId: "req_01JABCDEF0123456",
};

/** The body a mailto link carries, decoded. */
function bodyOf(mailto: string): string {
  const url = new URL(mailto);
  return url.searchParams.get("body") ?? "";
}

test("Contact Support writes to support, with the four facts", () => {
  const mailto = supportMailto(facts);
  expect(mailto.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
  expect(new URL(mailto).searchParams.get("subject")).toBe("Ponzu support");
  const body = bodyOf(mailto);
  expect(body).toContain("Version: 2.0.0");
  expect(body).toContain("Commit: abc1234def5678");
  expect(body).toContain("Environment: production");
  expect(body).toContain("Last request id: req_01JABCDEF0123456");
  // Scrubbed as anything else the app sends out is, and that changes nothing in a clean body.
  expect(scrubSecretsText(body)).toBe(body);
});

test("no token, session or address reaches the email, whatever a field holds", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfMSJ9.c2lnbmF0dXJlc2lnbmF0dXJl";
  const leaky = {
    version: `2.0.0 ${token}`,
    commit: "Bearer sk-ant-api03-0123456789abcdefghijklmnop",
    environment: "https://api.ponzu.design/?code=abc",
    lastRequestId: `${token}`,
  };
  const body = bodyOf(supportMailto(leaky));
  expect(body).not.toContain(token);
  expect(body).not.toContain("sk-ant");
  expect(body).not.toContain("Bearer");
  expect(body).not.toContain("code=");
  expect(body).toContain("Version: unknown");
  expect(body).toContain("Commit: unknown");
  expect(body).toContain("Environment: unknown");
  expect(body).toContain("Last request id: none");
  expect(scrubSecretsText(body)).toBe(body);
});

test("before any request, and without a commit, the email says so", () => {
  const body = supportBody({ ...facts, commit: null, lastRequestId: null });
  expect(body).toContain("Commit: unknown");
  expect(body).toContain("Last request id: none");
  // Exactly the lines it means to have, after room for the person's own words.
  expect(body.split("\n").filter((line) => line.includes(": "))).toEqual([
    "Please keep these lines: they help us find what happened.",
    "Version: 2.0.0",
    "Commit: unknown",
    "Environment: production",
    "Last request id: none",
  ]);
});

test("the request id comes from the API's answer, in any case, and only when it fits", () => {
  expect(requestIdOf({ "X-Request-Id": ["req_01JABCDEF0123456"] })).toBe("req_01JABCDEF0123456");
  expect(requestIdOf({ "x-request-id": "abcdefgh-1234" })).toBe("abcdefgh-1234");
  expect(requestIdOf({ "x-request-id": ["short"] })).toBeNull();
  expect(requestIdOf({ "x-request-id": ["has spaces in it"] })).toBeNull();
  expect(requestIdOf({ "content-type": ["application/json"] })).toBeNull();
  expect(requestIdOf(undefined)).toBeNull();
});

test("the Help menu's pages are ponzu.design's, exactly", () => {
  expect(HELP_LINKS).toEqual({
    privacy: "https://ponzu.design/privacy",
    terms: "https://ponzu.design/terms",
  });
});
