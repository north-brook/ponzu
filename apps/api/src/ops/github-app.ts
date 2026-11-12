/*
 * What the API needs of its GitHub App, which the selfcheck holds GitHub's own answer to
 * (`GET /app`). It is written from what the code asks for, not read from an App manifest:
 * there is none in the repository yet. When `infra/github-app/*.json` exists (production
 * slice 12), a test should hold each manifest to these.
 */

/** Each permission the API uses and the least level it uses it at. */
export const APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  /** Reading a repository at all, and what everyone reaches. */
  metadata: "read",
  /** Reading files for ideas and checkpoints, and the runner's pushes. */
  contents: "write",
  /** Opening, updating and merging a canvas's pull request. */
  pull_requests: "write",
  /** A pull request's checks and statuses, for its summary and Merge. */
  checks: "read",
  statuses: "read",
  /** An organization's members and their roles (`github/people.ts`). */
  members: "read",
  /**
   * A person's verified addresses at sign-in (`deps/github.ts` `listEmails`). GitHub's settings
   * page calls it "Email addresses"; `GET /app` names it `emails`.
   */
  emails: "read",
};

/**
 * The webhook events `github/webhook.ts` acts on that an App must subscribe to. `installation`,
 * `installation_repositories`, `installation_target` and `github_app_authorization` are sent to
 * every App without a subscription, and GitHub does not list them, so they are not here.
 */
export const APP_EVENTS: readonly string[] = [
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
];

/** How much each level allows: `write` covers `read`, and `admin` covers both. */
const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** The permissions in `APP_PERMISSIONS` that `granted` lacks or holds at too low a level. */
export function missingPermissions(granted: Record<string, string>): string[] {
  return Object.entries(APP_PERMISSIONS)
    .filter(([name, level]) => (LEVELS[granted[name] ?? ""] ?? 0) < LEVELS[level]!)
    .map(([name]) => name);
}

/** The events in `APP_EVENTS` that `subscribed` lacks. */
export function missingEvents(subscribed: readonly string[]): string[] {
  return APP_EVENTS.filter((event) => !subscribed.includes(event));
}
