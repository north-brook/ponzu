# Legal facts

The facts behind the site's legal drafts, for the founder and counsel. Each claim in
`apps/web/app/(legal)/` is listed here with the code or setting that makes it true, or marked as
something the code cannot answer. A change to the code that changes one of these facts updates
this file and the page in the same pull request.

The pages are drafts while `LEGAL_STATUS` in `apps/web/components/site.ts` is `"draft"`: each
shows a notice, is `noindex`, and is left out of the sitemap (`apps/web/legal.test.ts`). The
notes marked `[For the founder: …]` and `[For counsel: …]` on the pages (`<Open>` in the MDX)
are the open questions; the test fails if any remain once the status is `"in-effect"`.

The legal entity named is the real maker, Northbrook PBC (`ENTITY` in site.ts). Its registered
address and state are not in the code.

## Privacy Policy (`/privacy`)

| Claim | Where it is true | Status |
|---|---|---|
| Sign-in is GitHub through WorkOS; we keep GitHub user id, login, name, email, avatar | `packages/db/src/schema/accounts.ts` (`users`); docs/cloud.md "Identity and access" | true |
| Each sign-in's IP address and browser are passed to WorkOS | `apps/api/src/deps/workos.ts` (`ip_address`, `user_agent` in `authenticate`) | true; Ponzu's own `sessions` rows keep neither |
| The GitHub user token is encrypted, lasts eight hours, is refreshed, never leaves the servers | `github_user_tokens`; `apps/api/src/github/user-token.ts`; docs/cloud.md "Identity and access" | true |
| Workspaces, repositories and the person's permission on each, re-asked when old | `memberships`, `repo_access` (`checked_at`, made stale by webhooks) | true |
| People GitHub lists for each installed repository, including people who never opened Ponzu; display only | `workspace_people` and its comment | true |
| Canvases, comments, thread, change history, files, previews, exports, comment pictures | `packages/db/src/schema/canvases.ts`; docs/cloud.md "Assets and previews" | true |
| How far each person has read a canvas and its thread, and when; presence while a canvas is open | `canvas_reads` (`seen_seq`, `seen_thread_seq`, `seen_at`), `presence` | true |
| Checkpoints: transcript and uncommitted work, at a turn's end and before a sleep; ignored files, files over 5 MB and secret-looking files never saved | `apps/runner/src/save/work.ts` (`LIMITS`); docs/cloud.md "Saving the sandbox", "Known constraints" | true |
| Checkpoints sit under a random key handed only to the canvas's sandbox | docs/cloud.md "Known constraints": in the assets bucket until `R2_PRIVATE_BUCKET` is set | true; the draft does **not** say "private bucket" (test-enforced) |
| Commits pushed to `pz/<topic>`, authored as the person at their GitHub noreply address | `apps/api/src/canvases/branch.ts`; `apps/api/src/runner/session.ts` (`author`) | true |
| Pull requests opened, updated and merged as the person, when they or their turn asks | docs/cloud.md "The agent's pull request" | true |
| Sandbox disk and snapshot at Vercel | docs/cloud.md "The sandbox" | true |
| Repo ideas: description, topics, language, file layout, README, up to four manifests, one theme file, and for a small repo the start of up to two files, to Anthropic on Ponzu's key | `apps/api/src/ideas/read-repo.ts`, `snapshot.ts` (`BUDGET`), `apps/api/src/deps/model.ts` | true. The site's plan listed only description, topics, tree, README and manifests; the draft follows the code |
| Claude credential (OAuth token or API key) encrypted, with plan label, account email, an API key's last four (`key_hint`), and the limits and models Claude reports; decrypted only to start the sandbox; in memory, never on disk or in a snapshot | `claude_accounts`; docs/cloud.md "Credentials", "The sandbox" | true |
| Whether Vercel keeps the start command's env | docs/cloud.md "Known constraints": not documented, asked in writing | unknown; the draft says so |
| Repo secrets: names and encrypted values, admins set them, given to sandboxes in memory | `repo_secrets`; docs/cloud.md "Repo environments" | true |
| Usage: awake seconds per canvas and person; model, tokens and cost per turn | `usage_events` in `packages/db/src/schema/billing.ts` | true |
| Free credits and the cap; Stripe customer, card brand and last four once billing starts | `credit_ledger`; `workspaces.stripe_customer_id`, `card_brand`, `card_last4` | columns exist; Stripe is not built |
| iPhone: push token, name, app version, install id; pings not sent | `devices`; `apps/api/src/deps/push.ts` (off without `EXPO_ACCESS_TOKEN`); docs/cloud.md "Notifications" ("Nothing sends pushes yet") | true |
| Analytics identified by Ponzu id with name, email, GitHub login, grouped by workspace (name, repo count); never a canvas's name, repo contents or typed text | `apps/api/src/analytics/analytics.ts` (`identify`); docs/analytics.md "Shared rules" ("Identity", "Groups", "Canvases") | true |
| PostHog and IP addresses | The server's client sets `disableGeoip` (`apps/api/src/analytics/posthog.ts`). The apps' and site's posthog-js send from the person's browser, so PostHog sees their IP; whether it keeps it depends on the project's "Discard client IP data" setting | founder reads the setting; open note on the page |
| Model-call metadata; prompts and replies only with `PONZU_POSTHOG_AI_CONTENT` | docs/analytics.md "Switching it on" (dev is on, code default off) | production setting open |
| Session replay masks every input and blocks secret fields; `private` hides boards, thread, comments, names | `apps/studio/src/app/analytics/privacy.ts`; docs/analytics.md "Session replay" | production mode open |
| Turning it off: `PONZU_TELEMETRY=0`, `DO_NOT_TRACK=1`, `~/.ponzu/telemetry.json` `{"enabled": false}` | `apps/desktop/src/telemetry-consent.ts` | true for the desktop app. The settings switch is site slice S10; the cloud iPhone app's analytics are not built |
| Logs carry ids and outcomes, never tokens, bodies or headers | docs/cloud.md "Security", last paragraph | true by rule; not mechanically enforced everywhere |
| Website: cookieless PostHog, no person profiles, no recordings; nothing under DNT or GPC; a session-storage crash marker holding the page path, only while analytics runs; a session-storage note that a download started (`ponzu-download-started:<file>`), always | `apps/web/components/site-analytics.ts`, `consent.ts`, `health.ts`; `apps/web/app/download/download.tsx` (`AutoStart`); `site-analytics.test.ts` | true in code. PostHog drops cookieless events until the project's setting is on. "Visits told apart by a hash on PostHog's servers" is PostHog's documentation, not our code |
| Servers, database and storage in the US; Cloudflare caches files at its edge | `apps/api/vercel.json` (`iad1`); PostHog default host `us.i.posthog.com` | Neon region and R2 location are the founder's to read |
| Who can see a canvas: readers of its repo in the workspace; pushers steer; Scratch is the owner's alone | docs/cloud.md "Identity and access", line "A Scratch canvas has no repo and is its owner's alone" | true |
| Files at unguessable ponzu.cloud addresses; the key is the capability | docs/cloud.md "Assets and previews" | true |
| The owner or a workspace admin can reset a canvas's file links; the old addresses stop working about fifteen minutes later | `POST /v1/canvases/:id/asset-key/rotate` and the `canvas.asset_key_retire` job (`apps/api/src/canvases/asset-key.ts`); `routes/canvas-files.test.ts` | true in code once deployed and migrated (`asset_key_rotated_at`). A copy Cloudflare or a browser already cached is not purged |
| GitHub App permissions: contents and pull requests write; checks, statuses, metadata, members read | docs/cloud.md "Pull requests" ("Measured on the test repository") | the production App is not created yet; founder confirms, including email access |
| History compacted after 7 days | `OP_RETENTION_DAYS` in `packages/db/src/queries/checkpoints.ts` | true |
| Snapshot expires 30 days after last use; Vercel removes the sandbox 14 days later | docs/cloud.md "The sandbox" | true (Vercel's behaviour) |
| A checkpoint is deleted when a newer one replaces it | `apps/api/src/runner/checkpoint.ts` (`clear`) | true |
| Claude sign-in and GitHub App install states (`auth_states`) deleted a day after they expire; finished background jobs and webhook records after 30 days | `sweepOldRows` in `packages/db/src/queries/retention.ts`, run hourly by `apps/api/src/cron/steps/retention.ts`; `retention.test.ts` | true in code once deployed. At most 5,000 rows of each a run, so a backlog takes hours to clear |
| Deleting a canvas removes document, thread, comments, events, questions, checkpoints, sandbox | `apps/api/src/routes/canvases.ts` (`delete`), `forgetCheckpoints` | true |
| Deleting a canvas, or the account that alone has it, removes its files; a pull request's pictures stay | `deleteCanvasAndFiles` in `apps/api/src/canvases/files.ts` records the `canvas.files_delete` job in the statement that deletes the row and runs it at once; `routes/canvas-files.test.ts`, `routes/account.test.ts` | true in code once deployed. Cloudflare's and browsers' caches are not purged (previews, exports and comment pictures are cached up to a year); open note on the page |
| Account deletion steps, what stays, the sole-admin refusal | `apps/api/src/account/delete.ts`; docs/cloud.md "Deleting an account" | true; the WorkOS delete is the `account.forget` job's, tried again for about six hours (`apps/api/src/account/forget.ts`) |
| On deletion, thread items and the actor of their ops become "Deleted user"; a comment author's name inside the document and checkpoints, and words in workspaces already left, are not rewritten | `anonymiseUser` in `packages/db/src/queries/account-deletion.ts`; docs/cloud.md "Deleting an account" (last paragraph) | true |
| GitHub grant revoked on account deletion | `revokeGithubGrant` in `apps/api/src/account/delete.ts`, `Github.deleteAuthorization` in `apps/api/src/deps/github.ts`; `routes/account.test.ts` | true in code, best effort: a failure is logged and the deletion goes on. Uses the App's existing client id and secret |
| PostHog person, events and recordings deleted on account deletion | `apps/api/src/account/forget.ts`, `apps/api/src/analytics/posthog-admin.ts`; `account/forget.test.ts` | true in code; off until the founder sets `PONZU_POSTHOG_PERSONAL_API_KEY` and `PONZU_POSTHOG_PROJECT_ID` on production (until then each deletion logs `analytics_forget_skipped`). PostHog deletes in batches, usually within about a week (its documentation). Not yet run against a real PostHog project |
| No full export | no export code beyond board PNG/PDF exports | true |
| No age gate | none in code; GitHub requires 13+ | true |

## Terms of Service (`/terms`)

| Claim | Where it is true |
|---|---|
| The agent runs code in a sandbox, can reach the internet, pushes the canvas's branch, opens, updates and merges pull requests as the person, within the repo's rules | docs/cloud.md "The sandbox", "The agent's pull request" |
| A workspace is a GitHub account where the App is installed; GitHub decides who is in it; admins set roles and the cap | `workspaces`, `memberships` (`role` is Ponzu's own) |
| Canvases of a member who leaves stay with the workspace | docs/cloud.md "Deleting an account" |
| Pay as you go, free credits pooled, card when they run out, monthly cap; at the cap no new turn starts until an admin raises it or the month resets, a running turn finishes | program settlement 1; docs/cloud.md "Billing". No numbers on this page; the pricing page reads `packages/db/src/rate-card.ts` |
| Free until billing starts | `BILLING_LIVE = false`; docs/cloud.md "Billing" ("There is no Stripe…") |
| We don't train models on content | no training code; the API's only model calls are ideas and their gate |
| MIT license for the code | `LICENSE` |
| "Your own Claude plan" | depends on Anthropic's written approval for subscription tokens in Ponzu's sandboxes (founder) |

## Subprocessors (`/subprocessors`)

The list is `apps/web/components/subprocessors.ts`, rendered by both `/subprocessors` and the
privacy policy's summary.

| Row | Where it is true |
|---|---|
| Vercel: API, site, sandboxes, iad1 | `apps/api/vercel.json`; `@vercel/sandbox` in `packages/sandbox` |
| Neon: database and realtime | `@neon/realtime` in apps/api; `DATABASE_URL`. Region: founder |
| Cloudflare: R2 and ponzu.cloud | `apps/api/src/deps/storage.ts`; `infra/cloudflare/assets-headers.json`. Bucket location: founder |
| WorkOS | `apps/api/src/deps/workos.ts` |
| PostHog | `posthog-node`, `@posthog/ai` in apps/api; posthog-js in the studio and the site |
| Anthropic (Ponzu's key, ideas) | `@ai-sdk/anthropic` in `apps/api/src/deps/model.ts` |
| Expo, app updates (in use) | `apps/mobile/eas.json`, EAS Update |
| Expo, pings (when it ships) | `apps/api/src/deps/push.ts`, `expo-server-sdk`, off without `EXPO_ACCESS_TOKEN` |
| Apple, APNs (when it ships) | carries what Expo's push service hands it |
| Stripe (when it ships) | not built |

GitHub and Anthropic for Claude Code turns are services the person connects, not subprocessors.
Google Fonts and https images load from the addresses a canvas names (`apps/desktop/src/csp.ts`).

## Security (`/security`) and security.txt

| Claim | Where it is true |
|---|---|
| Access from GitHub, checked on every request | docs/cloud.md "Security", "Identity and access" |
| Devices hold no GitHub, Claude or Vercel credential; sign-out ends the session at once | docs/cloud.md "Identity and access" |
| AES-256-GCM vault, key only in the API's env, bound to row and column | `apps/api/src/vault/vault.ts` |
| One Firecracker VM per canvas, a runner token for one canvas | docs/cloud.md "The sandbox", "Security" |
| Git tokens for one hour and one repository | docs/cloud.md "Git", "Security" |
| Merge, ready and auto-merge only in a turn a person began, as them, within repo rules | docs/cloud.md "The agent's pull request" |
| Canvas HTML sanitized, strict CSP, files on ponzu.cloud | `packages/core` sanitizing; `apps/desktop/src/csp.ts`; docs/cloud.md "Assets and previews" |
| The prompt-injection paragraph and what limits it, including that a talked-into command can get a one-hour git token, and cannot read the runner token | docs/cloud.md "Security", "Prompt injection" |
| Reporting: `security@ponzu.design` and GitHub private vulnerability reporting | `CONTACT` in site.ts; the founder enables private reporting on the repository |
| security.txt fields and a 180-day Expires, made again daily | `apps/web/components/security-txt.ts`, `app/security.txt/route.ts`; the `/.well-known/` rewrite in `next.config.ts` |

## Questions counsel will ask, with the answer or where to look

1. **What personal data, from whom?** The privacy table above. Schemas:
   `packages/db/src/schema/accounts.ts`, `canvases.ts`, `billing.ts`.
2. **Where is it, which regions?** API and sandboxes in iad1 (`apps/api/vercel.json`, docs/cloud.md
   "The sandbox"). PostHog is US (`https://us.i.posthog.com`). The Neon region is in
   `DATABASE_URL`'s host and the R2 location in the bucket's settings: the founder reads both.
3. **Retention per category?** "How long we keep it" on the policy. Nothing expires canvases.
   Operational rows: Claude sign-in and App install states go a day after they expire,
   finished jobs and webhook records after 30 days (`packages/db/src/queries/retention.ts`).
   Production Neon backups: `infra/neon.json` wants 7 days of history and daily backups kept
   35 days, once applied.
4. **Is account deletion complete?** `apps/api/src/account/delete.ts` and
   `apps/api/src/account/forget.ts`. The GitHub grant is revoked (best effort), and WorkOS and
   PostHog are asked to forget the person by a job that retries; the PostHog step needs the
   founder's personal key in production. Canvas files in R2 go through the same purge as
   deleting one canvas (`deleteCanvasAndFiles`); what Cloudflare's edge cached is not purged.
5. **Is customer content sent to AI providers?** Turns go to Anthropic under the person's own
   account. Only repository metadata and short excerpts go under Ponzu's key (docs/cloud.md
   "Ideas").
6. **Do we train models?** No training code exists.
7. **Ads, selling, sharing?** No ad or attribution SDKs. PostHog is the only analytics.
8. **What does session replay capture?** `apps/studio/src/app/analytics/privacy.ts`, and the two
   modes in docs/analytics.md. Production's mode is the founder's call.
9. **Cookies?** The site sets none after this change; it keeps one session-storage marker for
   crash detection. The apps use PostHog's local persistence. Whether EU and UK visitors need
   opt-in consent for app session replay is open.
10. **Encryption?** The vault (AES-256-GCM), TLS everywhere, vendors' encryption at rest.
11. **What can the agent do on GitHub?** The App's permission set and docs/cloud.md "The agent's
    pull request".
12. **Third-party requests from canvases?** Google Fonts and any https image
    (`apps/desktop/src/csp.ts`).
13. **What do logs contain?** docs/cloud.md "Security", last paragraph.
14. **Does Vercel store the start command's env, including secrets?** Unknown; asked in writing
    (docs/cloud.md "Known constraints").
15. **Are checkpoints in a private bucket?** No, not until `R2_PRIVATE_BUCKET` is set.
16. **Email?** None is sent today (WorkOS emails off; no digest).
17. **Age gating?** None in code; GitHub requires 13 or older.
18. **Export or portability?** None beyond board exports.
19. **Who at Northbrook can reach production data, the breach process, DPAs?** Not answerable
    from code; the founder answers.
20. **The Ponzu 1 policy** (`/privacy/ponzu-1`) is kept word for word. Its "This website"
    section describes the 1.x site (a PostHog cookie, Do Not Track); once this site replaces it at
    cutover, that section no longer describes ponzu.design. Should the archive say so?
21. **Safe harbor** wording for good-faith security research, on `/security`.
22. **IP addresses at PostHog.** The apps and the site send events from the person's browser.
    Is "Discard client IP data" on in the production project, and if not, does the policy need
    to say PostHog keeps the IP address and the location it derives?
