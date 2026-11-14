# Analytics

How Ponzu Cloud is instrumented with PostHog: product analytics, session replay, error tracking
and AI observability. The architecture is [cloud.md](cloud.md); this is the contract both sides
of the instrumentation (the server, and the apps) keep to.

## Projects

One PostHog project per environment.

| Environment | Reports to |
|---|---|
| dev (`api-dev.ponzu.design`, the Ponzu Dev app) | **Ponzu Dev** |
| production, after cutover | **Ponzu** |

Ponzu for iPhone sends no analytics yet: `apps/mobile/lib/telemetry.ts` names its events, but
`canTrack` is false and `track` does nothing. The website has its own cookieless analytics (see
[The website](#the-website)). The 1.x command line is no longer on this branch.

## Switching it on

Three values, all public. Nothing is captured until the key is set, and setting it is all it
takes.

| Variable | Meaning |
|---|---|
| `PONZU_POSTHOG_KEY` | The project's token, `phc_…`. Safe in client code. Unset: no client is made, nothing is sent, nothing throws. |
| `PONZU_POSTHOG_HOST` | Where PostHog takes events. `https://us.i.posthog.com` when unset. |
| `PONZU_POSTHOG_AI_CONTENT` | `1`: AI observability events carry the model's inputs and outputs (prompts, replies, tool arguments and results). Anything else, or unset: only metadata goes (model, tokens, cost, latency, tool names, outcome). Dev runs with `1`; production's setting is the founder's call, and the default in code is off. |

Forgetting a deleted person is a separate door, PostHog's private API, with three more values
on the API alone, none handed to a runner (docs/cloud.md, "Deleting an account"):

| Variable | Meaning |
|---|---|
| `PONZU_POSTHOG_PERSONAL_API_KEY` | A personal API key with `person:write`, scoped to the project. A secret. Set with the project id or not at all; unset, account deletion leaves PostHog alone and logs `analytics_forget_skipped`. |
| `PONZU_POSTHOG_PROJECT_ID` | The project's numeric id. |
| `PONZU_POSTHOG_API_HOST` | PostHog's app host, `https://us.posthog.com` when unset. Not the ingestion host. |

On the server, set them on the API's Vercel project for the environment. The API hands the first
three to each canvas's runner in its session (`POST /v1/runner/session`, `analytics`), so a
sandbox needs no variables of its own, and a change reaches a runner the next time one starts.
The runner's code that uses them is in the runner bundle the API serves, so it ships with the
API.

## Shared rules

- **Identity.** The PostHog distinct id is the Ponzu user id (`usr_…`, the `users` row the API
  authenticates). Person properties: `name`, `email`, `github_login`, and `signed_up_at` (set
  once). The server sets them at every sign-in.
- **Groups.** Group type `workspace`, key the workspace id (`ws_…`). Properties: `name` (the
  GitHub account's login), `kind` (`organization` or `user`), `repos` (how many the App
  reaches), `repository_selection` (`all` or `selected`). The server sets them whenever it reads
  the installation from GitHub.
- **Canvases.** Every event about a canvas carries `canvas_id`. Never a canvas's name, a repo's
  contents, a file path from someone's machine, or what someone typed (a message is its length).
- **One fact, one side.** A fact is captured once, by the side that knows it for certain. What
  happens on the server is a server event; what only the app knows (the screen showing, a setup
  step reached, an idea chosen instead of typing, a pane toggled, a hotkey, an update installed,
  a sign-in started or failed) is an app event. When unsure, the server owns it.
- **Names.** Events are lowercase "object verb" in the past tense (`canvas created`); properties
  are snake_case. Each side keeps its events in one typed catalogue, so a name cannot be misspelt
  at a call site: the server's is `apps/api/src/analytics/events.ts`.
- **Sessions.** The app sends its PostHog session with every request to the API, the PostHog
  way: posthog-js's `tracing_headers` adds `X-POSTHOG-SESSION-ID` and `X-POSTHOG-DISTINCT-ID`.
  The server puts `$session_id` on what it captures for that request (events, exceptions, model
  calls), so a recording links to its server events and traces. A message keeps the session it
  was sent from (`events.posthog_session_id`), so the agent's turn it begins is traced under it
  too. The server never takes the distinct id header for identity: who a request is about is who
  it authenticated as.
- **Never in the way.** PostHog being down, slow or blocked costs nothing a person sees. Nothing
  on a request's path waits on PostHog; every capture is wrapped so it cannot throw into product
  code; the queues are bounded (1,000 events on the API and the runner, 100 in the Mac app's main
  process); and each send has a time limit (5 seconds on the
  API, kept alive past the response by Vercel's `waitUntil`).
- **Never a secret.** No tokens, API keys, OAuth codes, Ponzu's own session ids, Claude
  credentials, vault contents, webhook payloads, authorization headers or request bodies. A URL
  goes without its query string. An exception's message and stack go through the same redaction
  as the logs, and so does an agent turn's content (`@ponzu/core/redact`).

## Server events

Captured by the API (`apps/api`), where the fact becomes true: after the statement that made it
so. Each is about the signed-in person and the workspace the request reached, unless it says
otherwise; one about no person (a webhook's, the sweep's) is captured without a person profile.
Every event about a workspace also carries `workspace_id`.

| Event | Properties | When |
|---|---|---|
| `user signed up` | | The first sign-in of a GitHub account: its `users` row was made. |
| `user signed in` | `new_user` | Every sign-in exchange that let someone in. |
| `user signed out` | | |
| `account deleted` | `deleted_canvases`, `kept_canvases` | About no one: the `account.forget` job asks PostHog to delete the person, and PostHog deletes only what it had before it was asked, so an event under their id would make them again. |
| `workspace connected` | `workspace_id`, `kind`, `repos` | The App was installed on an account, or installed again, or unsuspended. Once, even when its webhook and the setup read it at the same moment: the database tells exactly one of them it made the change. About whoever installed it when Ponzu knows them, else the person whose sign-in found it. |
| `workspace disconnected` | `workspace_id`, `reason` (`uninstalled`, `suspended`) | About no one. An uninstall is said by the reader that took it off the workspace; a suspension under one id per suspension, at GitHub's time for it. |
| `repo access changed` | `workspace_id`, `repos` | GitHub said the repos the App reaches changed. About no one. |
| `claude connected` | `kind` (`subscription`, `api_key`), `woke_canvases` | |
| `claude disconnected` | | |
| `canvas created` | `canvas_id`, `source` (`idea`, `prompt`, `scratch`), `with_message`, `model`, `effort` | `source` is `scratch` for a canvas with no repo, else what the create says (`source: "idea"` when the person chose one of the composer's ideas), else `prompt`. |
| `canvas deleted` | `canvas_id`, `by_owner` | |
| `canvas file links reset` | `canvas_id`, `by_owner` | The owner or an admin reset the canvas's file links from Share: its files moved under a new asset key, and links to the old one stop working. |
| `canvas settled` / `canvas reopened` | `canvas_id` | |
| `canvas taken over` | `canvas_id`, `woke` | A teammate took over a canvas whose owner left the workspace or deleted their account; it runs on their Claude from then on. `woke`: its feed held work no runner took, so it was woken. About the person who took it. |
| `message sent` | `canvas_id`, `first`, `characters`, `attachments` | `first`: the message a canvas began with, sent by its create. |
| `comment posted` | `canvas_id`, `reply` | A person's comment on the canvas, or a reply in one of its threads. |
| `turn stopped` | `canvas_id` | A person asked the agent to stop. |
| `turn started` | `canvas_id`, `turn_id` | Timed when the turn began. Captured when the runner reports the turn. About the person whose message began it. |
| `turn finished` | `canvas_id`, `turn_id`, `outcome` (`completed`, `failed`, `stopped`), `error_code`, `duration_ms`, `tool_calls`, `models`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `runner`, `bundle` | As above. `turn_id` is also the turn's trace id in LLM analytics. A report sent twice is the same event (its id is made from the turn's). `runner` is what the runner said it is (`runner/0.1.0+<bundle>`), `bundle` the first twelve hex of the runner bundle's SHA-256 it said it runs, null for a runner started outside a sandbox. |
| `turn lapsed` | `canvas_id`, `kinds`, `sent_again`, `agent_state`, `waited_ms` | The sweep gave up waiting for a turn a delivered event was owed (docs/cloud.md, "A turn that never came"). `sent_again`: a copy went into the feed. About the canvas's owner. |
| `turn stalled` | `canvas_id` | The runner said it was working and wrote nothing of the turn for an hour; the sandbox was started again. About the canvas's owner. |
| `question asked` | `canvas_id`, `question_id`, `kind` | The agent asked; about no one. |
| `question answered` | `canvas_id`, `question_id`, `kind` | |
| `notification created` | `kind`, `muted`, `suppressed` (`pref_off`, `looking`, `rate`, `no_device`, or null), `pushes`, `deferred` | A person was told something (an inbox row was written). `pushes`: how many phones it was planned for; `deferred`: they wait for the person at their Mac. About the person told. Never its title, body or link. |
| `push sent` | `kind` | Expo took a push to one phone. About the person it is for. |
| `push failed` | `kind`, `error` | Expo refused a push, in its ticket or later in its receipt, with Expo's code (`DeviceNotRegistered`, `MessageRateExceeded`, …). Never the token. |
| `email sent` | `kind` | Resend took an email (`digest`, `billing`, `team`, `recap` or `notice`), or had taken it already under the same key. About the person it is for. Never the address, subject or body. |
| `email refused` | `kind`, `failure` | Resend refused an email and it will not be tried again, with Resend's code (`validation_error`, …). About the person it was for. |
| `email unsubscribed` | `kind`, `via` (`one_click` or `page`) | A person turned an email off from the email itself: their mail app's one-click unsubscribe, or the button on the link's page. Following the link alone captures nothing. |
| `pull request created` / `merged` / `closed` | `canvas_id`, `number` | Once each, whichever of a route and a webhook sees it first. |
| `sandbox woke` | `canvas_id`, `start` (`create`, `resume`, `restart`), `fresh`, `recreated`, `duration_ms`, `image` | About the canvas's owner, whose Claude it runs on. `duration_ms` is from the wake's start until `ponzu-start` was sent. `create`: the session booted on an empty disk (a first wake, a new image, or a snapshot that expired); `resume`: from its snapshot; `restart`: the runner started again in a session that was already running (a changed Claude credential, or a session left running). `fresh`: the disk was empty, so the runner rebuilds from git and the last checkpoint. `recreated`: the sandbox was deleted and made again on a new image (docs/cloud.md, "How images roll out"). `image` is the `ponzu-runner@sha256:…` it runs. |
| `sandbox slept` | `canvas_id`, `why` (`idle`, `claude_unusable`, `claude_disconnected`, `owner_left`, `restart`, `failed`, `cycle`, `expired`), `awake_ms` | The sandbox was stopped after its runner shut down, and `awake_ms` metered. `restart`: put to sleep to be woken again at once (a runner unheard for 90 seconds, a lapsed or stalled turn); `cycle`: its session neared Vercel's 24-hour cap; `expired`: Vercel had already stopped the session when the sweep went to extend it. About the canvas's owner. |
| `sandbox restored` | `canvas_id`, `kind` (`rollback`, `rebuilt`) | A runner found its disk behind the last checkpoint. About no one. |
| `ideas generated` | `repo_id`, `count`, `duration_ms`, `attempts`, `input_tokens`, `output_tokens` | About whoever's visit started it. `count` is 1 to 4: ideas the gate found not visible (not something people see or do) are dropped. The tokens are the writer's; the gate's calls are traced as `repo_ideas_gate`. |
| `ideas skipped` | `repo_id`, `reason` (`rate_limited`, `rejected`, `unsafe`, `failed`) | `unsafe`: the gate found an idea asking the reader for something other than work on the canvas, so none were kept (what it said goes to the logs only, never here). `rate_limited` is said by every read of a due repo while its workspace is over the hourly limit, under one id per repo and hour, so PostHog keeps one; about no one. |
| `file uploaded` | `canvas_id`, `content_type`, `bytes` | A person's image reached a canvas. |
| `monthly cap set` | `cap_usd` | |
| `billing wall hit` | `reason` (`free_used`, `cap_reached`, `payment_failed`), `surface` (`create`, `message`), `can_manage`, `enforced` | A person's message, or create with one, met a workspace at a billing limit. Only while `PONZU_BILLING` is not off; `enforced` is false in observe, where it went through. |
| `canvas waiting on billing` | `canvas_id`, `reason` | A canvas's wake began waiting on its workspace's billing limit (billing on), once each time it starts waiting. About no one. |
| `billing notice` | `kind` (`free_used`, `cap_warning`, `cap_reached`, `payment_failed`) | A workspace's admins were pinged about billing, once a period for each kind (billing on). `payment_failed` is said on the first failed attempt of a period's invoice. About no one. |
| `period closed` | `status` (`unbilled`, `waived`, `invoiced`, `paid`, `payment_failed`), `used_credits`, `free_credits`, `billed_credits`, `charged_cents`, `people` | A workspace's billing period was closed and settled, once (billing observed or on): charged nothing, or invoiced at Stripe. About no one. |
| `invoice paid` | `charged_cents`, `attempts` | A period's invoice was paid, once (billing on). About no one. |
| `invoice payment failed` | `attempt`, `reason` (`failed`, `needs_confirmation`) | A payment of a period's invoice failed, or waits on the payer's bank to confirm it, once an attempt (billing on). About no one. |
| `card setup started` | `source` (`wall`, `settings`) | An admin opened Stripe's Checkout page to add the workspace's card (billing on). |
| `card added` | `brand`, `source`, `seconds_to_add` | A card setup ended with the card stored, once, about whoever started it. The brand only, never the card's digits or Stripe's ids. |
| `card setup ended` | `outcome` (`cancelled`, `expired`, `failed`) | A card setup ended without a card, once, about whoever started it. |
| `repo secret changed` | `repo_id`, `action` (`added`, `replaced`, `removed`) | Never the secret's name or value. |
| `search answered` | `q_length`, `terms`, `results`, `groups`, `ms` | A search of a workspace was answered (`POST /v1/workspaces/:id/search`). `q_length` is the query's length after trimming, `terms` how many terms it made, `results` the hits in all, `groups` the names of the groups with a hit, `ms` the time from the route's start to its answer. Never the words searched for. |

Not captured: reads other than a search, polls, presence, health checks, the cron's runs, and the runner's protocol
traffic (claims, acks, state reports, thread writes).

## Error tracking

An error nobody expected goes to PostHog's error tracking (`captureException`): a 500 from a
route, a failed background task, a webhook's or a job's failure, a failed step of the sandbox
sweep. Each carries the person, the workspace, `$session_id`, the route as declared
(`POST /v1/canvases/:id/messages`, never the address asked) and the request id, and is in the
logs exactly as before. A refusal (validation, not found, signed out, forbidden: any 4xx) is the
API working, and is not an exception.

## AI observability

### Model calls the API makes

The API's own model calls (today, the repo ideas under the create composer, and the gate that
checks them) go through `deps.model` and `deps.reviewer`, whose every call names its feature
(`repo_ideas`, `repo_ideas_gate`) and is traced, in PostHog's
documented way for AI SDK v7: `@ai-sdk/otel` with `PostHogSpanProcessor` from `@posthog/ai/otel`
(`apps/api/src/analytics/ai.ts`). `withTracing` from `@posthog/ai` wraps AI SDK v5 and v6 models
only, and refuses v7's. Each call is a trace attributed to the person the request is about, in
the workspace it was asked for (`$groups`), with `feature` and `workspace_id`, under the app's
session. With `PONZU_POSTHOG_AI_CONTENT` off, the AI SDK records no prompt or answer and the
processor drops whatever might carry one. A new model call from the API gets all of this by going
through `deps.model` (or `deps.reviewer`).

What these traces are not for, yet, is judging: PostHog's LLM-as-judge evaluations need each
call's input and output, which production does not send while `PONZU_POSTHOG_AI_CONTENT` is
off. Whether the model's output is good is measured offline by the eval suite (docs/evals.md),
and guarded at runtime by the gate (docs/cloud.md, "Ideas").

### Agent turns

Each turn of the agent in a canvas's sandbox is one trace in LLM analytics, sent by the runner
straight to PostHog (`apps/runner/src/agent/trace.ts`, `apps/runner/src/telemetry.ts`):

| Event | What |
|---|---|
| `$ai_trace` | The turn. `$ai_trace_id` is the turn's id (the result's uuid), with its latency, `tool_calls`, and how it ended (`$ai_error` is a kind, like `interrupted` or `api_error_429`, never Claude's words). |
| `$ai_generation` | Each model call, the main agent's (`agent`) and every subagent's (`subagent`): model, input and output tokens, cache reads and writes, latency, time to first token, stop reason. |
| `$ai_span` | Each tool call: its name, how long it took, whether it failed. A subagent's calls hang under the tool call that started it. |

Every event carries `canvas_id`, the `workspace` group, `ponzu_runner` (the runner and the bundle
it runs, `runner/0.1.0+<hash>`), `$ai_session_id` (the canvas id, so a
canvas's turns read as one conversation whatever Claude session each ran in), and `$session_id`
of the app session that sent the message, when it said. The distinct id is the person whose
message began the turn; a turn nobody's message began is about no one. With content on, the
prompt, the replies and the tools' arguments and results go too, each clipped to 16,000
characters and scrubbed on the way out: every value of the repo's secrets, the Claude credential
and the runner's token (the agent's environment holds the first two, so a command that prints it
would otherwise carry them), and anything that looks like a token or key. With it off those
properties are null.

The runner sends one more event on the same client, when the agent calls `send_feedback`:

| Event | Properties | When |
|---|---|---|
| `agent feedback sent` | `canvas_id`, `workspace_id`, `sentiment`, `category`, `tool`, `summary`, `details`, `ponzu_runner` | The agent told the Ponzu team something with `send_feedback` (the cloud guide asks it to when a tool gets in its way or works notably well). About no one: the agent sent it, so it goes under the workspace's id (the canvas's, without one) and without a person profile. `tool` is a tool's name or null; anything else the agent put there is dropped. `summary` and `details` are the agent's words: sent only with content on, scrubbed as a turn's content is; null with it off. With analytics off nothing is sent and the tool tells the agent so. |

Why the runner sends them itself: it has the whole of Claude Code's message stream, which is
large with content on, and the API's functions answer in 4.5 MB from a region a hundred
milliseconds away. The token is public. A turn never waits on PostHog: its events are built when
it ends and put on posthog-node's bounded queue, which sends itself every few seconds; the runner
flushes it as it gets ready to sleep and as it stops (within a few seconds), so what a turn did
leaves before the machine does. That flush runs beside the product's own (the thread, answers,
usage), never among them: a PostHog that fails at once cannot cut short the wait for them.

Why not `@posthog/ai`'s Claude Agent SDK integration: it fixes one trace id for a whole query
(the runner keeps one query per session, and its turns' ids are the results'), it cannot say per
turn who sent the message or from which app session, and it reads only the main thread's stream,
so subagents' model calls would be lost. The events are the documented manual-capture format.

## App events

Captured by the Mac app: its studio (`apps/studio`) and shell (`apps/desktop`). The app captures what only it
knows: what is on screen and what was pressed. A canvas created, a turn finished, a pull request
merged are the API's. The catalogue is `apps/studio/src/app/analytics/events.ts`, typed, so a
name can't be misspelt at a call site.

Every event carries `app_version`, `channel` (`Ponzu`, `Ponzu Dev` or `Ponzu Local`, a run from a checkout),
`platform` and `os_version`, `environment` (`dev` or `production`, the environment the build
was made for; `custom` for Ponzu Local pointed at an API of a developer's own) and `app_commit`
(the commit it was built from), the `workspace` group in view, and `$current_url` as the view's
synthetic URL (below). Nothing carries what someone typed, a canvas's or repo's name, or a path:
a canvas is its `canvas_id`.

| Event | Properties | When |
|---|---|---|
| `app opened` | `first_launch` | the launch's first window starts; a reload after a crash, or a window the Mac's dock opens again, isn't another |
| `update installed` | `from_version`, `to_version` | the first launch after an update |
| `update available` | `version` | an update has downloaded and the title bar offers it |
| `update restart clicked` | `version` | Restart, in its popover |
| `sign in started` | | Continue with GitHub |
| `sign in completed` | | the browser came back signed in |
| `sign in cancelled` | | another was started, or the browser closed |
| `sign in failed` | `reason`: `access_denied`, `refused`, `network`, `other` | |
| `setup step reached` | `step`: `where`, `claude`, `iphone` | a first-run step shows |
| `setup step completed` | `step` | it gives way to the next, or to the window |
| `idea chosen` | `position` | an idea on the create page is picked into the composer |
| `create prompt sent` | `source`: `idea`, `idea_edited`, `typed`; `project`: `repo`, `scratch`; `images` | the create page made its canvas |
| `canvas opened` | `canvas_id`, `via`: `sidebar`, `search`, `link`, `created`, `restored` | |
| `search result opened` | `kind`: `canvases`, `boards`, `comments`, `messages`, `pullRequests`, `people`; `position` | a ⌘K result opened, by its group and its place in the list from 0; never the words searched for or what the result says |
| `page switched` | `canvas_id` | |
| `pane toggled` | `pane`: `sidebar`, `thread`, `pull_request`; `open`; `canvas_id` | |
| `comment mode entered` | `canvas_id` | the canvas's Comment tool, by button or `C` |
| `hotkey used` | `hotkey`: `mod+k`, `mod+n`, `mod+,`, `mod+b`, `mod+alt+b`, `mod+p`, `mod+shift+enter` | the window's ⌘ shortcuts (`useShortcut`); ⌘1 to ⌘9 are not counted |
| `settings section viewed` | `section` | |
| `notice shown` | `notice` | a calm state, by what it is, never its words (`NoticeName`) |
| `notification shown` | `kind`, `surface`: `mac` | the Mac showed a banner from the person's inbox; never its title or body |
| `notification opened` | `kind`, `surface`: `mac`, `age_ms` | a banner was clicked; `age_ms` is how long after the notification was made |
| `billing dialog shown` | `reason`: `free_used`, `cap_reached`, `payment_failed`, `add_card` | a send met the billing wall (the API's 402 `billing_required`), or an admin chose Add a card in Plan and usage or on a canvas's line; only while billing is on; never an amount or a workspace's name |
| `billing dialog dismissed` | `reason` | it was closed without the card, cap or payment it asked for; the held send is dropped and its words stay where they were |
| `billing portal opened` | | an admin opened Stripe's portal from Plan and usage |
| `$pageview` | `canvas_id` while a canvas is open | the view changes |
| `$exception` | | an uncaught error or rejection in the studio, an error React can't render past, and the main process's uncaught exceptions and rejections |

Autocapture records clicks, changes and submits for heatmaps, dead clicks and paths, with no
element's text (`mask_all_text`) and none of its attributes (`mask_all_element_attributes`): a
sidebar row's `aria-label` names its canvas, repo and branch, and a board's `title` is its name.
What is left is each element's tag and place. Pointer-level detail is left to it.

**Views.** The studio has no routes and, in a development build, a page address that names the
checkout, so every event and recording says where the window is as a stable synthetic URL, and a
`$pageview` is captured when it changes: `ponzu://app/sign-in`, `/update`, `/setup/<step>`,
`/create`, `/canvas`, `/canvas/pull-request`, `/settings/<section>`, `/no-access`. The referrer is
always `$direct`.

**Identity.** The distinct id is the Ponzu user id, set when the session is known; person
properties are the API's. The `workspace` group is set for the workspace in view (name: the
GitHub login; kind: `organization` or `user`) and changes when the person switches. Signing out,
and deleting the account (which signs out), resets PostHog, so the next person on the Mac starts
anonymous. The main process puts its exceptions down to whoever is signed in.

**Linking to the server.** posthog-js `tracing_headers` adds `X-POSTHOG-SESSION-ID`,
`X-POSTHOG-WINDOW-ID` and `X-POSTHOG-DISTINCT-ID` to the studio's requests to the API's host
(the API's CORS allows them). The API reads the session id; identity is only ever the token's.

## Session replay

Every session is recorded when a project is set (turn session replay on, at 100%, in the
project's settings): the DOM, pointer and keys, console logs, and network timing (method, status
and duration, and the request's address: the API's with its path and without its query, anything
else only its origin, since a canvas's files sit under its asset key, which is the capability to
read them; never headers or bodies). Heatmaps and dead clicks are on.

Both modes mask every input, and block outright (an empty box of its size) anything that can
show a secret: PostHog's `ph-no-capture` class on the Claude card (its code and API key), a
secret's field in Needs you, and a repo's secrets in Settings. What else shows is one setting,
`PONZU_POSTHOG_REPLAY`:

| Mode | Shows |
|---|---|
| `private` (the default) | the chrome, the layout and every interaction. A canvas's boards are blocked wherever they are drawn (its live boards and pictures, the thread's miniatures and attachments, the sidebar's previews); the text and labels of the canvas (board names, comments), the thread and its composer, the create page's ideas, the pull request tab, and the sidebar's canvas names and search results are masked. |
| `full` (Ponzu Dev) | everything a person sees, boards and thread included. The recording keeps the addresses of a canvas's pictures so the player can show them, and with them the canvas's asset key: anyone who can watch a `full` recording can read that canvas's files. |

The rules are `apps/studio/src/app/analytics/privacy.ts`; `analytics.e2e.test.ts` records a
canvas in each mode against a local sink and checks what the recording holds.

## Pointing the Mac app at a project

Three public values, baked into the main process by `apps/desktop/scripts/build.ts` and handed
to the studio over the bridge, so the environment a build was made for decides the project:

- `PONZU_POSTHOG_KEY`: the project token, `phc_…`. Unset: nothing is reported, nothing of
  PostHog loads in the studio, and the content security policy reaches none of it.
- `PONZU_POSTHOG_HOST`: default `https://us.i.posthog.com`. The policy then allows exactly that
  host, and for PostHog's own cloud (`us` or `eu`) also its `-assets` host (remote config); no script source is added, since the studio
  bundles PostHog whole (`posthog-js/full/no-external`) and never loads one.
- `PONZU_POSTHOG_REPLAY`: `full` or `private` (anything else is `private`).

A run from a checkout (`bun run start`) also reads them from its environment. A test build
(`PONZU_TEST_BUILD=1`) and the smoke check (`PONZU_SMOKE=1`) never report. The release workflow
takes them from the repository variables `PONZU_APP_POSTHOG_KEY`, `PONZU_APP_POSTHOG_HOST` and
`PONZU_APP_POSTHOG_REPLAY`, never the 1.x `PONZU_POSTHOG_KEY` variable.

For Ponzu Dev:

```sh
cd apps/desktop
# Ponzu Dev, packaged
PONZU_POSTHOG_KEY=phc_… PONZU_POSTHOG_REPLAY=full bun run package:dev
# Ponzu Local, from a checkout
PONZU_POSTHOG_KEY=phc_… PONZU_POSTHOG_REPLAY=full bun run start
```

**Source maps.** With `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID` set (the release
workflow takes them from `PONZU_APP_POSTHOG_CLI_API_KEY` and `PONZU_APP_POSTHOG_CLI_PROJECT_ID`),
the builds write source maps, and before electron-builder packs the app
(`scripts/before-pack.cjs`) the PostHog CLI injects chunk ids and uploads the maps of the main
process, the preload and the studio, then deletes them. Without them, or if PostHog fails, any
map is deleted all the same: the app never ships one, and a release never fails for PostHog.

## Turning it off

**Settings › Account › Share usage data** is the person's switch, on by default. It lives on the
account (`users.share_usage`), so it follows them to every device, and it stops what is sent
about them from everywhere, not only from one computer:

- **The API.** `PATCH /v1/me/privacy` `{ shareUsage }` sets it, and captures nothing either way;
  `GET /v1/me` (`privacy.shareUsage`) and the `me` live row (`share_usage`) carry it. The API's
  analytics sink (`withoutOptedOut` in `apps/api/src/analytics/analytics.ts`) drops every
  capture, profile (`identify`) and exception whose person has turned it off. Who has is read
  (`select id from users where share_usage = false`) in the background send, never on a
  request's path, and kept a minute per instance; the instance that took the `PATCH` reads it
  again at once. While an instance holds no fresh copy, what it captures about a person waits
  for the next send's read (at most 1,000 held, each keeping the time it was captured), so
  nothing about someone who turned it off is ever sent on a guess. Events about no person (a
  sandbox put to sleep, a workspace's group) are not anyone's to stop and still go. The API's
  own model calls (repo ideas) are still traced for their workspace, about no one.
- **The agent.** Each event handed to a runner carries `trace` (false when the person behind it
  has turned sharing off, read from their row at the claim), and the runner sends no `$ai_*`
  events for a turn whose first event says false (`apps/runner/src/agent/trace.ts`). The API's
  own `turn started` and `turn finished` for that person are dropped by the sink. A turn already
  running when the switch is turned off keeps the flag it began with: that one turn's trace may
  still go; the next does not.
- **The Mac app.** Turning it off stops the studio's PostHog at once (`opt_out_capturing`, which
  PostHog keeps in its own storage, so it holds at the next launch), and the shell writes
  `{"enabled": false}` to `~/.ponzu/telemetry.json` (keeping whatever else 1.x kept there) and
  stops the main process's error reporting. Turning it on writes `{"enabled": true}` and opts
  the studio back in; where this launch loaded nothing to report with, recording starts at the
  next launch, and the row says "Recording resumes next time Ponzu opens" until then. Turned
  off on another device, a window that was reporting does the same as if it were turned off
  here. Turned on from another device, the studio's PostHog starts again if it was loaded, but
  the shell's file is written on only by the toggle on that computer, so a `ponzu telemetry off`
  from 1.x is never undone from elsewhere.
- **The iPhone** shows the same row, reading `me.shareUsage`, once the phone's analytics land.

On the Mac, as in 1.x, any of these also turns everything off, in the shell and the studio,
before anything loads, whatever the account says: `PONZU_TELEMETRY=0`, `DO_NOT_TRACK=1`, `CI`,
or `"enabled": false` in `~/.ponzu/telemetry.json` (what `ponzu telemetry off` wrote, and what
the switch writes).

What is not built: turning the switch on from another device does not turn a Mac back on whose
file says off; turn it on there. On a Mac that has never been told (no file, and no opt-out kept
in the studio's PostHog storage), a launch reports from the moment it opens until `GET /v1/me`
answers, usually a second or less: the app opened event, the first page view and the start of
a recording may go before the studio learns the switch is off, and from then on nothing does.
An API instance other than the one that took the `PATCH` keeps sending about the person for up
to a minute, until its copy of who is out is read again. The website's own analytics are cookieless and anonymous, and
are not tied to the account (below).

## The website

The website (`apps/web`) starts PostHog only when `NEXT_PUBLIC_POSTHOG_KEY` is set and the
browser sends neither Do Not Track nor Global Privacy Control (`components/consent.ts`,
`components/site-analytics.ts`). It runs cookieless, through `/ingest` on its own domain, with no
person profiles, autocapture or recordings. It sends page views, `download clicked` (`href`,
`page`), the phone handoff's `handoff opened`, `handoff copied`, `handoff shared` and
`handoff arrived` (`os`), `page crashed` and `page ready` (`components/health.ts`), uncaught
errors and web vitals. The crash marker it reads on the next visit sits in the tab's session
storage.

## What the Mac app never sends

Tokens, API keys, OAuth codes, Ponzu's session ids, Claude credentials, repo secrets,
authorization headers, request and response bodies, URL queries, and paths on someone's
computer: the main process replaces the home folder with `~` in what it sends, and a development
build's `/@fs/` paths lose the folders above the repo's own. As a backstop, every event the
studio and the shell send (an exception's message, say) passes through `scrubSecrets`
(`packages/client/src/telemetry-scrub.ts`): any URL in it loses its query and fragment, and
`code=…`, `token=…`, `Bearer …` and anything shaped like a GitHub, Anthropic, WorkOS or Ponzu
credential is replaced.

PostHog being down, slow or blocked costs nothing a person can see: nothing is awaited on a
request's path, every capture is guarded, PostHog's queues are bounded, and quitting waits two
seconds at most for the main process's last errors.
