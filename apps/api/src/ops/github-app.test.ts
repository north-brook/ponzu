import { expect, test } from "bun:test";
import { APP_EVENTS, APP_PERMISSIONS, missingEvents, missingPermissions } from "./github-app.ts";

/*
 * What GitHub answered `GET /app` for the development App on 2026-11-12: the names GitHub's API
 * really uses, which are not always the settings page's (its "Email addresses" is `emails`).
 * The list of what the API needs is held to it, so a name GitHub never sends cannot be asked for.
 */
const DEV_APP = {
  permissions: {
    checks: "read",
    contents: "write",
    emails: "read",
    members: "read",
    metadata: "read",
    pull_requests: "write",
    statuses: "read",
  },
  events: [
    "check_run",
    "check_suite",
    "member",
    "membership",
    "organization",
    "pull_request",
    "pull_request_review",
    "push",
    "repository",
    "team",
  ],
};

test("the development App as GitHub describes it holds every permission and event the API needs", () => {
  expect(missingPermissions(DEV_APP.permissions)).toEqual([]);
  expect(missingEvents(DEV_APP.events)).toEqual([]);
});

test("every permission and event the API asks for is a name GitHub's answer uses", () => {
  expect(Object.keys(APP_PERMISSIONS).sort()).toEqual(Object.keys(DEV_APP.permissions).sort());
  expect([...APP_EVENTS].sort()).toEqual([...DEV_APP.events].sort());
});

test("a permission held too low, or not at all, is named", () => {
  expect(missingPermissions({ ...DEV_APP.permissions, contents: "read" })).toEqual(["contents"]);
  const { emails: _emails, ...withoutEmails } = DEV_APP.permissions;
  expect(missingPermissions(withoutEmails)).toEqual(["emails"]);
});
