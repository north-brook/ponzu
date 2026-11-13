# Legal facts

The facts behind the site's legal pages, for the founder and counsel. Each claim in
`apps/web/app/(legal)/` is listed here with the code or setting that makes it true, or marked as
something the code cannot answer. A change to the code or a production setting that changes one
of these facts updates this file and the page in the same pull request.

The pages are in effect: `LEGAL_STATUS` in `apps/web/components/site.ts` is `"in-effect"` and
`LEGAL_EFFECTIVE` is November 13, 2026. That puts them in the sitemap, drops the `noindex` and
the draft notice, and ends each page on "Last updated November 13, 2026." (`apps/web/legal.test.ts`).
The privacy policy still links to the Ponzu 1 policy (`/privacy/ponzu-1`) in its last section, and
the desktop app's Settings and Help menu link to `/privacy`, `/privacy#analytics` and `/terms`
(`apps/studio/src/cloud/settings/account.tsx`, `apps/desktop/src/support.ts`). The `<Open>`
component stays for future drafts; the test fails if one appears while the pages are in effect.

Facts read from production on November 13, 2026 (by the orchestrator, or read-only from the
vendor) are marked **prod**. They are settings, not code, so a change at the vendor makes the
page wrong until this file and the page change too.

The legal entity is Northbrook PBC (`ENTITY` in site.ts), a Delaware corporation at 169 Madison
Ave, Suite 2504, New York, NY 10016; the founder gave both on November 13, 2026. The privacy
policy draws the address after the name (`ENTITY.address`), and the terms' governing law names
`ENTITY.state` ("the State of Delaware"). `legal.test.ts` fails if the pages are in effect and
the state is null.

## Privacy Policy (`/privacy`)

| Claim | Where it is true | Status |
|---|---|---|
| Who we are: Northbrook PBC, with the address only when `ENTITY.address` is set | `ENTITY` in `apps/web/components/site.ts` | address unknown; not drawn |
| "You can delete your account in the desktop app's Settings" | `DELETE /v1/me`; the Mac's Settings › Account; Ponzu for iPhone 1.0.0 has no Delete account (`apps/mobile/app/settings.tsx`: "Delete account join[s] it with [its] slice") | true |
| Sign-in is GitHub through WorkOS; we keep GitHub user id, login, name, email, avatar | `packages/db/src/schema/accounts.ts` (`users`); docs/cloud.md "Identity and access" | true |
| Each sign-in's IP address and browser are passed to WorkOS | `apps/api/src/deps/workos.ts` (`ip_address`, `user_agent` in `authenticate`) | true; Ponzu's own `sessions` rows keep neither |
| The GitHub user token is encrypted; GitHub issues it through WorkOS at sign-in; it lasts eight hours and is refreshed with GitHub directly; used only to call GitHub from our servers | `github_user_tokens`; `apps/api/src/auth/sign-in.ts` (the token arrives with WorkOS's finished sign-in, stored by `storeGithubUserToken`); `apps/api/src/github/user-token.ts` (refresh with GitHub) | true. The draft's "It never leaves our servers" left out that it passes through WorkOS |
| Workspaces, repositories and the person's permission on each, re-asked when old | `memberships`, `repo_access` (`checked_at`, made stale by webhooks) | true |
| People GitHub lists for each installed repository, including people who never opened Ponzu; display only | `workspace_people` and its comment | true |
| What GitHub tells us: pushes, pull requests and reviews, checks, changes to repositories, members and teams; each notice's record kept 30 days to recognise a redelivery | **prod**: the App "Ponzu Cloud" (`ponzu-cloud`) subscribes to check_run, check_suite, member, membership, organization, pull_request, pull_request_review, push, repository, team; `webhook_deliveries`, `WEBHOOK_RETENTION_DAYS` in `packages/db/src/queries/retention.ts` | true |
| Canvases, comments, thread, change history, files, previews, exports, comment pictures | `packages/db/src/schema/canvases.ts`; docs/cloud.md "Assets and previews" | true |
| How far each person has read a canvas and its thread, and when; presence while a canvas is open | `canvas_reads` (`seen_seq`, `seen_thread_seq`, `seen_at`), `presence` | true |
| Checkpoints: transcript and uncommitted work, at a turn's end and before a sleep; ignored files, files over 5 MB and secret-looking files never saved | `apps/runner/src/save/work.ts` (`LIMITS`); docs/cloud.md "Saving the sandbox", "Known constraints" | true |
| Checkpoints are kept in a bucket of their own, not served on the web, under a random key handed only to the canvas's sandbox | `deps.archives` and `PRIVATE_PURPOSES` (`apps/api/src/uploads/files.ts`); docs/cloud.md "Saving the sandbox" ("Where it is stored"); **prod**: `R2_PRIVATE_BUCKET` is set (`infra/environments.json`: `ponzu-private`) | true |
| Commits pushed to `pz/<topic>`, authored as the canvas's owner at their noreply address, whoever asked; as the App's bot once the owner is gone | `apps/api/src/canvases/branch.ts`; `apps/api/src/runner/session.ts` (`author: owner ? … : committer`) | true. The draft's "authored as you" was false for anyone steering a canvas they do not own |
| Turns start from a person, or from a failed check or a review; the pull request is acted on as the person whose turn it is, otherwise the last person who wrote, else the owner; merge, ready and auto-merge only in a person's turn, as them | `apps/api/src/github/pull-requests.ts` (`queueWake` for `check` and `review`); `apps/api/src/pull-requests/agent.ts` (`actingFor`, `PERSON_ONLY`); docs/cloud.md "The agent's pull request" | true |
| Sandbox disk and snapshot at Vercel | docs/cloud.md "The sandbox" | true |
| Repo ideas: description, topics, language, file layout, README, up to four manifests, one theme file, and for a small repo the start of up to two files, to Anthropic on Ponzu's key | `apps/api/src/ideas/read-repo.ts`, `snapshot.ts` (`BUDGET`), `apps/api/src/deps/model.ts` | true |
| Claude credential (OAuth token or API key) encrypted, with plan label, account email, an API key's last four (`key_hint`), and the limits and models Claude reports; decrypted only to start the sandbox; in memory, never on disk or in a snapshot | `claude_accounts`; `apps/api/src/sandboxes/environment.ts` (the only `vault.open` of it); docs/cloud.md "Credentials", "The sandbox" | true |
| "Vercel does not document whether it keeps a record of that command's environment, so we cannot promise it does not." | docs/cloud.md "Known constraints" ("Secrets in a command's env") | true. The draft's "we have asked Vercel in writing" is gone: whether it was asked is the founder's to confirm |
| Repo secrets: names and encrypted values; admins set them, and anyone who may steer a canvas can give one when the agent asks; given to sandboxes in memory | `repo_secrets`; `apps/api/src/routes/canvas-thread.ts` (the `secret` question: "Anyone who may steer the canvas may give one"); `apps/api/src/routes/runner.ts` (`POST /v1/runner/secret`, once to the asking runner); docs/cloud.md "Repo environments" | true |
| Usage: awake seconds per canvas and person; model, tokens and cost per turn | `usage_events` in `packages/db/src/schema/billing.ts` | true |
| Free credits and the cap; Stripe customer, card brand and last four once billing starts; "Billing has not started." | `credit_ledger`; `workspaces.stripe_customer_id`, `card_brand`, `card_last4`; `BILLING_LIVE = false` | true; Stripe is not built |
| Inbox of notifications: ids, the canvas's or workspace's name, the first names of the people it is about, and Ponzu's own sentence; never the words of a message or comment | `notifications` (`title`, `body`, `people`; migration `0030_notifications.sql`, `packages/db/src/schema/notifications.ts`); `apps/api/src/notifications/copy.ts` (`titleOf(canvasName)`, `commentBody`, `prApprovedBody`); nothing sets `subtitle` | true. The draft's "never words a person or the agent wrote" was false: canvas names are people's words |
| Notification settings and the time zone the desktop app reports | `users.ping_needs_you` and the other `ping_*` toggles, `users.time_zone` (0030); `PATCH /v1/me/notifications`; `apps/studio/src/app/notifications.ts` (`timeZoneToSend`) | true |
| Each computer the desktop app runs on: install id, computer name, app version, when last there | `devices` (`install_id`, `name`, `app_version`, `active_at`, `last_seen_at`); `apps/studio/src/app/notifications.ts` (`register` with `platform: "macos"`); `apps/desktop/src/main.ts` (`installIdIn`, `deviceNameOf(computerName())`) | true |
| Ponzu for iPhone does not register for notifications; nothing is sent to phones or by email | `apps/mobile` has no push registration (no `getExpoPushTokenAsync`, no `devices.register`); **prod**: pushes and email are not sent (orchestrator), and `RESEND_API_KEY` is what turns email on (docs/cloud.md "Notifications") | true |
| Dictation on iPhone is turned into text on the phone; audio is not sent to us | `apps/mobile/lib/dictation.ts` (`requiresOnDeviceRecognition: true`), `apps/mobile/lib/listen.ts` (refuses without an on-device model) | true |
| Analytics events from the desktop app and servers, identified by Ponzu id with name, email, GitHub login, grouped by workspace (name, repo count); never a canvas's name, repo contents or typed text | `apps/api/src/analytics/analytics.ts` (`identify`); docs/analytics.md "Shared rules" | true |
| Clicks in the desktop app for heatmaps, without text or labels | `apps/studio/src/app/analytics/posthog.ts` (`autocapture`, `mask_all_text`, `mask_all_element_attributes`, `capture_heatmaps`) | true |
| Model-call metadata only, "Never the prompts, the replies, or what tools were given and returned" | **prod**: `PONZU_POSTHOG_AI_CONTENT` is not set, so the code's default (off) holds: docs/analytics.md "Switching it on", "Agent turns" ("With it off those properties are null"); `infra/environments.json` `aiContent: false` | true |
| Recordings: screen, pointer, keys, console messages, request timing (addresses without queries, never contents); inputs masked; secret fields blocked; boards hidden; canvas, thread, comments, pull request tab, suggested prompts and canvas names masked on screen; "Console messages are recorded as the app writes them" (masking does not reach them) | `apps/studio/src/app/analytics/posthog.ts` (`enable_recording_console_log`, `capture_performance.network_timing`, `recordHeaders: false`, `recordBody: false`, `maskCapturedNetworkRequestFn`); `privacy.ts`; docs/analytics.md "Session replay"; **prod**: release builds use `private` (repository variable `PONZU_APP_POSTHOG_REPLAY=private`) | true |
| IP addresses: the desktop app and site send from the person's device; "Our PostHog project does not discard it"; the server's events go without it | **prod**: PostHog project 731171 `anonymize_ips: false` (read through PostHog's API, November 13, 2026); the server's client sets `disableGeoip` (`apps/api/src/analytics/posthog.ts`) | true |
| Ponzu for iPhone sends nothing to PostHog in this version; while a TestFlight beta, Apple may send us crash reports and feedback the tester allows | `apps/mobile/lib/telemetry.ts` (`canTrack = false`, `track` does nothing); no `posthog-react-native` client is made in app code (the package is there for the build's source-map plugin, `app.config.ts`, `metro.config.js`) | true for 1.0.0; the build carries `EXPO_PUBLIC_POSTHOG_KEY` but nothing reads it. TestFlight crash reports and feedback are Apple's (App Store Connect), shared at the tester's choice |
| Turning it off: Settings › Account › Share usage data in the desktop app; "on until you turn it off"; on the account; stops the server's captures, profiles and errors about the person, the agent's traces of turns they start, and the desktop app's reporting; a running turn may still be traced; events about no one still go | `users.share_usage` (default true, migration 0029); `PATCH /v1/me/privacy` (`apps/api/src/routes/me.ts`); `withoutOptedOut` in `apps/api/src/analytics/analytics.ts`; `apps/runner/src/agent/trace.ts`; `apps/studio/src/app/analytics/sharing.ts`; docs/analytics.md "Turning it off" | true. Whether EU and UK visitors must opt in instead is the founder's (and counsel's) decision; the page describes what happens and does not answer it |
| Turning it off on one computer: `PONZU_TELEMETRY=0`, `DO_NOT_TRACK=1`, `~/.ponzu/telemetry.json` `{"enabled": false}` | `apps/desktop/src/telemetry-consent.ts` (any platform: `join(home, ".ponzu", "telemetry.json")`) | true; the draft said "On a Mac", but the desktop app reads it on Windows and Linux too |
| "To have that deleted, write to privacy@ and we will ask PostHog to delete it" | a promise the team keeps by hand (PostHog's person delete) | promise |
| Our own log lines carry ids and outcomes, never tokens, bodies or headers; Vercel keeps its own record of requests, as any web host does; both at Vercel | `apps/api/src/http/log.ts` (every logger line through `redact`); docs/cloud.md "Security", last paragraph; Vercel's request logs are the platform's | true. The draft's "Our servers log…" read as all logs; Vercel's request log is not ours to redact |
| Website: cookieless PostHog, no person profiles, no recordings; nothing under DNT or GPC; a session-storage crash marker; a session-storage download note; downloads come from GitHub | `apps/web/components/site-analytics.ts`, `consent.ts`, `health.ts`; `apps/web/app/download/download.tsx`; `apps/web/components/platforms.ts` (`LATEST` is GitHub's releases); **prod**: cookieless mode is on in project 731171 (`cookieless_server_hash_mode: 2`) | true. "Visits told apart by a hash on PostHog's servers" is PostHog's documentation |
| Servers, sandboxes and database in the US: Vercel iad1 (Washington, D.C.), Neon AWS us-east-1 (N. Virginia); PostHog in the US; Cloudflare stores files and checkpoints and delivers files worldwide; data from outside the US is processed in the US | `apps/api/vercel.json` (`iad1`); docs/cloud.md "Layout" (sandboxes in iad1); **prod**: Vercel iad1, Neon aws-us-east-1, PostHog Cloud US (`us.i.posthog.com`) | true. The R2 buckets' location is not stated: the founder reads it |
| Who can see a canvas: the people GitHub has given its repo to (its owner and collaborators, read-only ones included, and for a public repo its organization's members), who are in its workspace; that a repo is public does not by itself let anyone open its canvases; pushers steer; Scratch is the owner's alone | docs/cloud.md "Identity and access"; `recordReposReachedBy` and `repoPermission` in `apps/api/src/auth/repo-access.ts`; `apps/api/src/auth/public-repo-read.test.ts` | true once the API with this rule is deployed. Before it, anyone in a workspace could open the canvases of its public repos |
| Files at unguessable ponzu.cloud addresses; reset of file links, old addresses stop about fifteen minutes later | `apps/api/src/canvases/asset-key.ts`; `routes/canvas-files.test.ts` | true. Cached copies are not purged |
| GitHub App permissions: contents and pull requests (write); checks, statuses, metadata, members and email addresses (read) | **prod**: the App "Ponzu Cloud" (`ponzu-cloud`), read from GitHub: checks read, contents write, emails read, members read, metadata read, pull_requests write, statuses read | true |
| History compacted as checkpoints are saved: changes older than seven days, beyond the newest 200 | `OP_RETENTION_DAYS = 7`, `UNDO_DEPTH = 200` and the prune in `writeCheckpoint` (`packages/db/src/queries/checkpoints.ts`) | true |
| Snapshot expires 30 days after last use; Vercel removes the sandbox 14 days later | docs/cloud.md "The sandbox" | true (Vercel's behaviour) |
| A checkpoint is deleted when a newer one replaces it | `apps/api/src/runner/checkpoint.ts` (`clear`) | true |
| A notification leaves the inbox three days after it was made if unread, is deleted after 30 days; a computer unseen 30 days is forgotten | `apps/api/src/cron/steps/prune-notifications.ts` (`NOTIFICATION_EXPIRES_MS`, `NOTIFICATION_KEPT_MS`, `MAC_KEPT_MS`) | true |
| Auth states a day after they expire; finished jobs and webhook records after 30 days | `sweepOldRows` in `packages/db/src/queries/retention.ts` | true. At most 5,000 rows of each a run |
| (not on the page yet) A record of each legal notice emailed to each person: the notice, the person's id, the workspace for a suspension, the address it went to, when, Resend's id and the outcome | `email_notices` (`packages/db/src/schema/email.ts`), written only by `apps/api/scripts/notice.ts`; `user_id` has no foreign key, so account deletion keeps the record; nothing deletes it | no retention period is set: how long it is kept is the founder's (with counsel) to decide, and the privacy page should then say it and that deletion keeps it. No notice has been sent: production has no `RESEND_API_KEY` |
| Analytics: recordings kept 30 days; events with no project limit, as long as the plan keeps them | **prod**: project 731171 `session_recording_retention_period: "30d"`; events retention read through PostHog's API: no project or organization period, the plan's default (84 months) does not delete (`default_period_deletes: false`) | true. The page names no period for events, because none deletes them today |
| Backups: a day of database history; a copy taken each time we update our servers, kept 14 days | **prod**: Neon history retention is 86,400 seconds (one day). `infra/neon.json`'s 7 days and daily backups kept 35 days are **not applied**. The production job in `.github/workflows/deploy-api.yml` snapshots the default branch on every run (every approved push to `main`), whether or not a migration is pending (`neon.ts --snapshot`, `SNAPSHOT_DAYS = 14`) | true. The draft's "before a change to the database's structure" was false: the copy is taken on every deploy. Change the page when `infra/neon.json` is applied |
| Logs: as long as Vercel keeps them on our plan | no log drain in `infra/` | true either way; the period is Vercel's |
| Deleting a canvas removes document, thread, comments, events, questions, checkpoints, sandbox and its files; a pull request's pictures stay | `apps/api/src/routes/canvases.ts` (`delete`), `deleteCanvasAndFiles` in `apps/api/src/canvases/files.ts` | true |
| Cached copies: previews, exports and comment pictures up to a year, other files up to five minutes | `IMMUTABLE` (`max-age=31536000`) and `CHANGEABLE` (`max-age=300`) in `apps/api/src/uploads/files.ts`; no Cloudflare purge in code | true. Whether to add a purge is the founder's decision |
| Account deletion steps, what stays, the sole-admin refusal; notifications and devices go with the account; the person's entry in a workspace's list of people stays while GitHub lists them | `apps/api/src/account/delete.ts`; `notifications.user_id` and `devices.user_id` `on delete cascade`; `workspace_people` is keyed by GitHub id with no link to `users` (`packages/db/src/schema/accounts.ts`); docs/cloud.md "Deleting an account" | true |
| On deletion, thread items and op actors become "Deleted user"; a comment author's name in the document and checkpoints, and words in workspaces already left, are not rewritten | `anonymiseUser` in `packages/db/src/queries/account-deletion.ts` | true |
| GitHub grant revoked on account deletion | `revokeGithubGrant` in `apps/api/src/account/delete.ts` | true, best effort |
| "Deleting your account does not yet delete what PostHog holds about you by itself. Write to privacy@ and we will ask PostHog…" | `apps/api/src/account/forget.ts` skips PostHog without `PONZU_POSTHOG_PERSONAL_API_KEY` and `PONZU_POSTHOG_PROJECT_ID` (logs `analytics_forget_skipped`); **prod**: neither is set | true. Once both are set, the page goes back to "We ask PostHog to delete your profile, events and recordings, which it does in batches, usually within about a week. If PostHog is down, we keep asking for several hours." |
| Rights: see (with a machine-readable copy), correct, delete, object; no full export in the apps; answered within the time the law allows | board PNG/PDF exports; no account export code. A copy is made by hand from the database on request | promise a small team can keep |
| GDPR and UK GDPR: account, work, credentials and usage used to provide Ponzu under the terms; logs and error reports to keep it secure and working; complaint to a data protection authority | the purposes above | wording; the basis for product analytics is not named (founder decision) |
| California: right to know, delete, correct, not be treated differently; we do not sell or share, and no targeted advertising | no ad or attribution SDKs; PostHog is the only analytics | true |
| Children: at least 13, at least 16 in the EEA; accounts of younger people deleted when we learn of them | no age gate in code; GitHub requires 13+ | promise |
| Changes: a change that uses data in a new way is told at least 30 days ahead, by email where we have the address, and on the page | the email is a `privacy_change` notice sent with `apps/api/scripts/notice.ts`, which refuses one less than 30 days ahead and records each person (`email_notices`); the page by hand; `users.email` can be null, hence "where we have your address" (recorded `no_address`) | promise, matching the terms; no notice written or sent yet |

## Terms of Service (`/terms`)

| Claim | Where it is true |
|---|---|
| Age: at least 13, at least 16 in the EEA; a parent or guardian agrees for someone under the age of majority; an organization's user confirms they may accept for it | wording; no age gate in code |
| Claude: your own subscription or API key, under Anthropic's terms | `/v1/claude` (docs/cloud.md "Credentials"). Whether Anthropic approved subscription sign-in in writing is the founder's to confirm; the clause says only what the product does |
| The agent runs code in a sandbox and can reach the internet; commits authored as the canvas's owner; turns from a person, a failed check or a review; the pull request acted on as the person whose turn it is (else the last person who wrote, else the owner); merge, ready and auto-merge only in a person's turn, within the repo's rules | `apps/api/src/runner/session.ts` (`author`); `apps/api/src/github/pull-requests.ts` (`queueWake`); `apps/api/src/pull-requests/agent.ts` (`actingFor`, `PERSON_ONLY`); docs/cloud.md "The sandbox", "The agent's pull request" |
| Responsibility for what is merged on your behalf, for the repositories and secrets given, and for what the repository's code does with them at other services | wording; the agent runs repository code with the repo's secrets (`apps/api/src/sandboxes/environment.ts`) |
| Acceptable use adds: no pointing the agent at code or services you have no right to, or breaking GitHub's or Anthropic's terms; no use from a place or by a person the US does not allow us to serve | wording |
| Suspension: we say why by email if we have the address, unless the law forbids or it would help harm; a person looks again on request | a promise; no suspension tooling in code besides the email, a `suspension` notice sent with `apps/api/scripts/notice.ts` (the reason as the founder writes it, escaped, at most 1,000 characters; replies go to `PONZU_EMAIL_REPLY_TO`); `users.email` can be null |
| A workspace is a GitHub account where the App is installed; admins set roles and the cap; once billing starts it pays | `workspaces`, `memberships` |
| Canvases of a member who leaves stay with the workspace | docs/cloud.md "Deleting an account" |
| "Ponzu is free until billing starts. Billing has not started." | `BILLING_LIVE = false`; docs/cloud.md "Billing" ("There is no Stripe…") |
| Once billing starts: pay as you go, free credits pooled, card when they run out, monthly cap; at the cap no new turn starts, a running turn finishes | docs/cloud.md "Billing". No numbers on this page |
| 30 days' notice before billing starts and before a price rise, by email where we have the address, and on the pricing page; nothing charged until an admin adds a card; taxes added where required; no refunds except by law or mistake; a rise applies from the next month | promises; billing is not built. The emails are the `billing-starts` notice (its day not written yet) and a `price_rise` notice, sent with `apps/api/scripts/notice.ts`, which refuses either less than 30 days ahead and sends them to every organisation admin and each personal workspace's person |
| As between you and us, what you make (including the agent's code) is yours; we claim no rights in it | wording |
| We don't train models on content; what goes to Anthropic under the person's account follows their terms and settings there | no training code; turns go to Anthropic under the person's own credential (`apps/api/src/sandboxes/environment.ts`) |
| Feedback may be used freely | wording |
| MIT license for the code | `LICENSE` |
| Ending: deletion in the desktop app, after handing on a sole admin role; suspension or closure for breach, risk or law; 30 days' notice before Ponzu stops; pushed code on GitHub, boards as PNG or PDF, threads and comments not exportable; what survives (what is owed, Disclaimers, Governing law) | `apps/api/src/account/delete.ts` (409 `sole_admin`); no thread or comment export in the apps; the closing email is a `shutdown` notice sent with `apps/api/scripts/notice.ts`, refused less than 30 days ahead |
| Warranty disclaimer; no indirect damages for us or the people who work for us; cap at the greater of the last twelve months' fees and one hundred US dollars; the law's limits; indemnity for content that breaks the law or others' rights and for breach, limited for consumers | wording (the cap still makes sense once billing starts) |
| Governing law and venue: `ENTITY.state`'s law and courts, or "the state in which Northbrook PBC is incorporated" until set; write to us first; consumers keep mandatory local law and courts | `STATE` in `terms/page.mdx`, from `ENTITY.state`; `legal.test.ts` ("the terms name the state whose law governs them") |
| Material changes: 30 days' notice, by email where we have the address, and on the page; sooner if the law or abuse needs it | promise; the email is a `terms_change` notice sent with `apps/api/scripts/notice.ts`, which refuses one less than 30 days ahead unless given `--sooner`; `users.email` can be null |

## Subprocessors (`/subprocessors`)

The list is `apps/web/components/subprocessors.ts`, rendered by both `/subprocessors` and the
privacy policy's summary. A row names a region only where we chose one; otherwise it says the
company decides.

| Row | Where it is true |
|---|---|
| Vercel: API, site, sandboxes; United States (Washington, D.C., iad1) | `apps/api/vercel.json`; `@vercel/sandbox` in `packages/sandbox`; **prod** iad1 |
| Neon: database and realtime; the IP address of each device connected for live updates; United States (AWS us-east-1, N. Virginia) | `@neon/realtime` in apps/api; clients subscribe at the branch's Realtime endpoint (`apps/api/src/deps/realtime.ts`); **prod** aws-us-east-1 |
| Cloudflare: R2 and ponzu.cloud; checkpoints in a bucket of their own; "Delivered through Cloudflare's network worldwide" | `apps/api/src/deps/storage.ts`; **prod** `R2_PRIVATE_BUCKET` set. Bucket location: founder |
| WorkOS: identity, the GitHub token of each sign-in as it passes through, each sign-in's IP and browser | `apps/api/src/deps/workos.ts`; `apps/api/src/auth/sign-in.ts` |
| PostHog: desktop app, server and site; IP address of events sent from the device; United States (PostHog Cloud US) | `posthog-node`, `@posthog/ai` in apps/api; posthog-js in the studio and the site; **prod** project 731171 on `us.i.posthog.com`, `anonymize_ips: false`. The iPhone app sends nothing |
| Anthropic (Ponzu's key, ideas) | `@ai-sdk/anthropic` in `apps/api/src/deps/model.ts` |
| Expo, app updates (in use): IP address, platform, runtime version, channel, and whatever else the library sends | `expo-updates`, `updates.url` in `apps/mobile/app.json`. Exactly which headers `expo-updates` adds (for example a per-install id) was not read: its sources are not in this repository |
| Expo, pings (not in use yet) | `apps/api/src/deps/push.ts`, off without `EXPO_ACCESS_TOKEN`; **prod**: pushes not sent |
| Apple, APNs (not in use yet) | carries what Expo's push service hands it |
| Resend, the daily email (not in use yet) | `apps/api/src/deps/mail.ts`, off without `RESEND_API_KEY`; **prod**: email not sent |
| Stripe (not in use yet) | not built |

The pricing page (`apps/web/app/pricing/page.tsx`) says billing lives in the desktop app and
names the desktop and iPhone apps, matching these pages. Its "never charged past" the cap is
`chargedCredits` in `apps/api/src/billing/credits.ts`, which charges at most what the cap pays
for.

GitHub and Anthropic for Claude Code turns are services the person connects, not subprocessors.
Google Fonts and https images load from the addresses a canvas names (`apps/desktop/src/csp.ts`).
The desktop app's updates come from GitHub Releases (`publish` in `apps/desktop/package.json`,
`apps/desktop/src/updater.ts`), and the site's download links point there
(`apps/web/components/platforms.ts`).

## Security (`/security`) and security.txt

| Claim | Where it is true |
|---|---|
| Access from GitHub, checked on every request | docs/cloud.md "Security", "Identity and access" |
| Devices hold no GitHub, Claude or Vercel credential; sign-out ends the session at once | docs/cloud.md "Identity and access" |
| AES-256-GCM vault, key only in the API's env, bound to row and column | `apps/api/src/vault/vault.ts` |
| One Firecracker VM per canvas, a runner token for one canvas | docs/cloud.md "The sandbox", "Security" |
| Git tokens for one hour and one repository | docs/cloud.md "Git", "Security" |
| Merge, ready and auto-merge only in a turn a person began, as them, within repo rules | `apps/api/src/pull-requests/agent.ts` (`PERSON_ONLY`); docs/cloud.md "The agent's pull request" |
| "Our logs carry no secrets": our own log lines carry ids and outcomes, each logger line redacted | `apps/api/src/http/log.ts` (`createLogger` runs `redact`) |
| Canvas HTML sanitized, strict CSP, files on ponzu.cloud | `packages/core` sanitizing; `apps/desktop/src/csp.ts`; docs/cloud.md "Assets and previews" |
| The prompt-injection paragraph and what limits it | docs/cloud.md "Security", "Prompt injection" |
| Reporting: `security@ponzu.design`; GitHub private vulnerability reporting only while `GITHUB_PRIVATE_REPORTING` is true | `CONTACT` and `GITHUB_PRIVATE_REPORTING` in site.ts. **prod**: private reporting is off on the repository (`GET /repos/north-brook/ponzu/private-vulnerability-reporting` answered `enabled: false`), so the page and security.txt name only the mailbox. The mailbox is on Google (the domain's MX) |
| "We do not run a paid bounty program." | nothing in the repository runs one |
| Good-faith research safe harbour and its rules; covers Ponzu's own apps, service and site, not vendors' systems | wording |
| security.txt fields and a 180-day Expires, made again daily | `apps/web/components/security-txt.ts`, `app/security.txt/route.ts`; the `/.well-known/` rewrite in `next.config.ts` |

## Facts still to come from the founder

Each is written around on the pages so that what they say is true without it.

1. Who at Northbrook can reach production data, and when (the privacy policy says nothing on it).
2. Whether Vercel was asked in writing about the start command's environment, and its answer.
3. Whether Anthropic approved Claude subscription sign-in in Ponzu's sandboxes in writing.
4. The R2 buckets' location setting.
5. Turning on GitHub private vulnerability reporting, then setting `GITHUB_PRIVATE_REPORTING`.
6. Setting `PONZU_POSTHOG_PERSONAL_API_KEY` and `PONZU_POSTHOG_PROJECT_ID` on production, then
   putting back the automatic PostHog deletion sentence (above).
7. Applying `infra/neon.json`, then changing "Backups" on the privacy policy.

## Questions counsel will ask, with the answer or where to look

8. **What personal data, from whom?** The privacy table above. Schemas:
   `packages/db/src/schema/accounts.ts`, `canvases.ts`, `billing.ts`, `notifications.ts`.
9. **Where is it, which regions?** API and sandboxes in Vercel iad1, the database in Neon
   aws-us-east-1, PostHog Cloud US. The R2 location is the founder's to read.
10. **Retention per category?** "How long we keep it" on the policy. Production Neon history is
   one day until `infra/neon.json` is applied.
11. **Is account deletion complete?** `apps/api/src/account/delete.ts` and `forget.ts`. The
   PostHog step is skipped in production until the founder sets its key; the policy says to write
   to us meanwhile.
12. **Is customer content sent to AI providers?** Turns go to Anthropic under the person's own
   account. Only repository metadata and short excerpts go under Ponzu's key.
13. **Do we train models?** No training code exists.
14. **Ads, selling, sharing?** No ad or attribution SDKs. PostHog is the only analytics.
15. **What does session replay capture?** `apps/studio/src/app/analytics/privacy.ts`; production
   is `private`.
16. **Cookies and consent?** The site sets none. The desktop app keeps PostHog's state in local
   storage and records sessions unless the person turns sharing off. Whether EU and UK people must
   opt in instead is open; the policy describes what happens without answering it.
17. **Encryption?** The vault (AES-256-GCM), TLS everywhere, vendors' encryption at rest.
18. **What can the agent do on GitHub?** The App's permission set above.
19. **Third-party requests from canvases?** Google Fonts and any https image.
20. **What do logs contain?** docs/cloud.md "Security", last paragraph.
21. **Does Vercel store the start command's env?** Not documented.
22. **Are checkpoints in a private bucket?** Yes in production (`R2_PRIVATE_BUCKET`).
23. **Email?** None is sent by the service today (no `RESEND_API_KEY`).
24. **Age gating?** None in code; the terms and policy set 13, and 16 in the EEA.
25. **Export or portability?** Board exports in the apps; a copy of personal data by hand on request.
26. **Who at Northbrook can reach production data, the breach process, DPAs?** The founder answers.
27. **The Ponzu 1 policy** (`/privacy/ponzu-1`) is kept word for word. Its "This website"
    section describes the 1.x site, not today's ponzu.design. Should the archive say so?
28. **IP addresses at PostHog.** "Discard client IP data" is off in production, and the policy
    says PostHog keeps the address events from the device came from.
