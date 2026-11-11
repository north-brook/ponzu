# Analytics

How Ponzu Cloud is instrumented with PostHog: product analytics, session replay, error tracking
and AI observability. The architecture is [cloud.md](cloud.md); this is the contract both sides
of the instrumentation (the server, and the apps) keep to.

## Projects

One PostHog project per environment.

| Environment | Reports to |
|---|---|
| dev (`api.ponzu.design` today, the Ponzu Dev app) | **Ponzu Dev** |
| production, after cutover | **Ponzu** |

The pre-cloud product's project, and the telemetry in `apps/cli`, `apps/mobile` and `apps/web`
that reports to it, are left alone. They are deleted or repointed at cutover, and that project
is retired after it.

## Switching it on

Three values, all public. Nothing is captured until the key is set, and setting it is all it
takes.

| Variable | Meaning |
|---|---|
| `PONZU_POSTHOG_KEY` | The project's token, `phc_…`. Safe in client code. Unset: no client is made, nothing is sent, nothing throws. |
| `PONZU_POSTHOG_HOST` | Where PostHog takes events. `https://us.i.posthog.com` when unset. |
| `PONZU_POSTHOG_AI_CONTENT` | `1`: AI observability events carry the model's inputs and outputs (prompts, replies, tool arguments and results). Anything else, or unset: only metadata goes (model, tokens, cost, latency, tool names, outcome). Dev runs with `1`; production's setting is the founder's call, and the default in code is off. |

On the server, set them on the API's Vercel project for the environment. The API hands all
three to each design's runner in its session (`POST /v1/runner/session`, `analytics`), so a
sandbox needs no variables of its own, and a change reaches a runner the next time one starts.
The runner's code that uses them is in the sandbox image: an image baked before this landed
traces nothing, whatever the API says.

## Shared rules

- **Identity.** The PostHog distinct id is the Ponzu user id (`usr_…`, the `users` row the API
  authenticates). Person properties: `name`, `email`, `github_login`, and `signed_up_at` (set
  once). The server sets them at every sign-in.
- **Groups.** Group type `workspace`, key the workspace id (`ws_…`). Properties: `name` (the
  GitHub account's login), `kind` (`organization` or `user`), `repos` (how many the App
  reaches), `repository_selection` (`all` or `selected`). The server sets them whenever it reads
  the installation from GitHub.
- **Designs.** Every event about a design carries `design_id`. Never a design's name, a repo's
  contents, a file path from someone's machine, or what someone typed (a message is its length).
- **One fact, one side.** A fact is captured once, by the side that knows it for certain. What
  happens on the server is a server event; what only the app knows (the screen showing, a setup
  step reached, an idea chosen instead of typing, a pane toggled, a hotkey, an update installed,
  a sign-in started or failed) is an app event. When unsure, the server owns it.
- **Names.** Events are lowercase "object verb" in the past tense (`design created`); properties
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
  code; the queues are bounded (1,000 events); and each send has a time limit (5 seconds on the
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
| `account deleted` | `deleted_designs`, `kept_designs` | |
| `workspace connected` | `workspace_id`, `kind`, `repos` | The App was installed on an account, or installed again, or unsuspended. Once, even when its webhook and the setup read it at the same moment: the database tells exactly one of them it made the change. About whoever installed it when Ponzu knows them, else the person whose sign-in found it. |
| `workspace disconnected` | `workspace_id`, `reason` (`uninstalled`, `suspended`) | About no one. An uninstall is said by the reader that took it off the workspace; a suspension under one id per suspension, at GitHub's time for it. |
| `repo access changed` | `workspace_id`, `repos` | GitHub said the repos the App reaches changed. About no one. |
| `claude connected` | `kind` (`subscription`, `api_key`), `woke_designs` | |
| `claude disconnected` | | |
| `design created` | `design_id`, `source` (`idea`, `prompt`, `scratch`), `with_message`, `model`, `effort` | `source` is `scratch` for a design with no repo, else what the create says (`source: "idea"` when the person chose one of the composer's ideas), else `prompt`. |
| `design deleted` | `design_id`, `by_owner` | |
| `design settled` / `design reopened` | `design_id` | |
| `message sent` | `design_id`, `first`, `characters`, `attachments` | `first`: the message a design began with, sent by its create. |
| `comment posted` | `design_id`, `reply` | A person's comment on the canvas, or a reply in one of its threads. |
| `turn stopped` | `design_id` | A person asked the agent to stop. |
| `turn started` | `design_id`, `turn_id` | Timed when the turn began. Captured when the runner reports the turn. About the person whose message began it. |
| `turn finished` | `design_id`, `turn_id`, `outcome` (`completed`, `failed`, `stopped`), `error_code`, `duration_ms`, `tool_calls`, `models`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `runner`, `image` | As above. `turn_id` is also the turn's trace id in LLM analytics. A report sent twice is the same event (its id is made from the turn's). `runner` is what the runner said it is (`runner/0.1.0+<image>`), `image` the image it said it runs in, null for a runner too old to say. |
| `question asked` | `design_id`, `question_id`, `kind` | The agent asked; about no one. |
| `question answered` | `design_id`, `question_id`, `kind` | |
| `pull request created` / `merged` / `closed` | `design_id`, `number` | Once each, whichever of a route and a webhook sees it first. |
| `sandbox woke` | `design_id`, `start` (`new`, `cold`, `warm`, `moved`), `duration_ms`, `image` | About the design's owner, whose Claude it runs on. `moved`: made new from the current image in place of one from an older image (docs/cloud.md, "How images roll out"). `image` is the image it runs, null for one made before images were recorded. |
| `sandbox moved` | `design_id`, `from_image`, `to_image`, `duration_ms` | The design moved onto a new sandbox from the current image, which restored its last checkpoint. As `sandbox woke`. A move that failed is an exception with the design and the image. |
| `sandbox slept` | `design_id`, `quiesced` | `quiesced`: its runner said it was ready before the stop. |
| `sandbox lost` | `design_id` | The provider lost the sandbox or its disk; the wake made a new one. |
| `sandbox restored` | `design_id`, `kind` (`rollback`, `rebuilt`) | A runner found its disk behind the last checkpoint. About no one. |
| `ideas generated` | `repo_id`, `count`, `duration_ms`, `attempts`, `input_tokens`, `output_tokens` | About whoever's visit started it. |
| `ideas skipped` | `repo_id`, `reason` (`rate_limited`, `rejected`, `failed`) | `rate_limited` is said by every read of a due repo while its workspace is over the hourly limit, under one id per repo and hour, so PostHog keeps one; about no one. |
| `file uploaded` | `design_id`, `content_type`, `bytes` | A person's image reached a design. |
| `monthly cap set` | `cap_usd` | |
| `repo secret changed` | `repo_id`, `action` (`added`, `replaced`, `removed`) | Never the secret's name or value. |

Not captured: reads, polls, presence, health checks, the cron's runs, and the runner's protocol
traffic (claims, acks, state reports, thread writes).

## Error tracking

An error nobody expected goes to PostHog's error tracking (`captureException`): a 500 from a
route, a failed background task, a webhook's or a job's failure, a failed step of the sandbox
sweep. Each carries the person, the workspace, `$session_id`, the route as declared
(`POST /v1/designs/:id/messages`, never the address asked) and the request id, and is in the
logs exactly as before. A refusal (validation, not found, signed out, forbidden: any 4xx) is the
API working, and is not an exception.

## AI observability

### Model calls the API makes

The API's own model calls (today, the repo ideas under the create composer) go through
`deps.model`, whose every call names its feature (`repo_ideas`) and is traced, in PostHog's
documented way for AI SDK v7: `@ai-sdk/otel` with `PostHogSpanProcessor` from `@posthog/ai/otel`
(`apps/api/src/analytics/ai.ts`). `withTracing` from `@posthog/ai` wraps AI SDK v5 and v6 models
only, and refuses v7's. Each call is a trace attributed to the person the request is about, in
the workspace it was asked for (`$groups`), with `feature` and `workspace_id`, under the app's
session. With `PONZU_POSTHOG_AI_CONTENT` off, the AI SDK records no prompt or answer and the
processor drops whatever might carry one. A new model call from the API gets all of this by going
through `deps.model`.

### Agent turns

Each turn of the agent in a design's sandbox is one trace in LLM analytics, sent by the runner
straight to PostHog (`apps/runner/src/agent/trace.ts`, `apps/runner/src/telemetry.ts`):

| Event | What |
|---|---|
| `$ai_trace` | The turn. `$ai_trace_id` is the turn's id (the result's uuid), with its latency, `tool_calls`, and how it ended (`$ai_error` is a kind, like `interrupted` or `api_error_429`, never Claude's words). |
| `$ai_generation` | Each model call, the main agent's (`agent`) and every subagent's (`subagent`): model, input and output tokens, cache reads and writes, latency, time to first token, stop reason. |
| `$ai_span` | Each tool call: its name, how long it took, whether it failed. A subagent's calls hang under the tool call that started it. |

Every event carries `design_id`, the `workspace` group, `ponzu_runner` (the runner and the image
it runs in, `runner/0.1.0+ponzu-runner-<hash>`), `$ai_session_id` (the design id, so a
design's turns read as one conversation whatever Claude session each ran in), and `$session_id`
of the app session that sent the message, when it said. The distinct id is the person whose
message began the turn; a turn nobody's message began is about no one. With content on, the
prompt, the replies and the tools' arguments and results go too, each clipped to 16,000
characters and scrubbed on the way out: every value of the repo's secrets, the Claude credential
and the runner's token (the agent's environment holds the first two, so a command that prints it
would otherwise carry them), and anything that looks like a token or key. With it off those
properties are null.

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
knows: what is on screen and what was pressed. A design created, a turn finished, a pull request
merged are the API's. The catalogue is `apps/studio/src/app/analytics/events.ts`, typed, so a
name can't be misspelt at a call site.

Every event carries `app_version`, `channel` (`Ponzu`, `Ponzu Dev` or `Ponzu Local`, a run from a checkout),
`platform` and `os_version`, the `workspace` group in view, and `$current_url` as the view's
synthetic URL (below). Nothing carries what someone typed, a design's or repo's name, or a path:
a design is its `design_id`.

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
| `create prompt sent` | `source`: `idea`, `idea_edited`, `typed`; `project`: `repo`, `scratch`; `images` | the create page made its design |
| `design opened` | `design_id`, `via`: `sidebar`, `search`, `link`, `created`, `restored` | |
| `page switched` | `design_id` | |
| `pane toggled` | `pane`: `sidebar`, `thread`, `pull_request`; `open`; `design_id` | |
| `comment mode entered` | `design_id` | the canvas's Comment tool, by button or `C` |
| `hotkey used` | `hotkey`: `mod+k`, `mod+n`, `mod+,`, `mod+j` | the window's ⌘ shortcuts |
| `settings section viewed` | `section` | |
| `notice shown` | `notice` | a calm state, by what it is, never its words (`NoticeName`) |
| `$pageview` | `design_id` on a design | the view changes |
| `$exception` | | an uncaught error or rejection in the studio, an error React can't render past, and the main process's uncaught exceptions and rejections |

Autocapture records clicks, changes and submits for heatmaps, dead clicks and paths, with no
element's text (`mask_all_text`) and none of its attributes (`mask_all_element_attributes`): a
sidebar row's `aria-label` names its design, repo and branch, and a board's `title` is its name.
What is left is each element's tag and place. Pointer-level detail is left to it.

**Views.** The studio has no routes and, in a development build, a page address that names the
checkout, so every event and recording says where the window is as a stable synthetic URL, and a
`$pageview` is captured when it changes: `ponzu://app/sign-in`, `/update`, `/setup/<step>`,
`/create`, `/design`, `/design/pull-request`, `/settings/<section>`, `/no-access`. The referrer is
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
else only its origin, since a design's files sit under its asset key, which is the capability to
read them; never headers or bodies). Heatmaps and dead clicks are on.

Both modes mask every input, and block outright (an empty box of its size) anything that can
show a secret: PostHog's `ph-no-capture` class on the Claude card (its code and API key), a
secret's field in Needs you, and a repo's secrets in Settings. What else shows is one setting,
`PONZU_POSTHOG_REPLAY`:

| Mode | Shows |
|---|---|
| `private` (the default) | the chrome, the layout and every interaction. A design's boards are blocked wherever they are drawn (the canvas's live boards and pictures, the thread's miniatures and attachments, the sidebar's previews); the text and labels of the canvas (board names, comments), the thread and its composer, the create page's ideas, the pull request tab, and the sidebar's design names and search results are masked. |
| `full` (Ponzu Dev) | everything a person sees, boards and thread included. The recording keeps the addresses of a design's pictures so the player can show them, and with them the design's asset key: anyone who can watch a `full` recording can read that design's files. |

The rules are `apps/studio/src/app/analytics/privacy.ts`; `analytics.e2e.test.ts` records a
design in each mode against a local sink and checks what the recording holds.

## Pointing the Mac app at a project

Three public values, baked into the main process by `apps/desktop/scripts/build.ts` and handed
to the studio over the bridge, so the environment a build was made for decides the project:

- `PONZU_POSTHOG_KEY`: the project token, `phc_…`. Unset: nothing is reported, nothing of
  PostHog loads in the studio, and the content security policy reaches none of it.
- `PONZU_POSTHOG_HOST`: default `https://us.i.posthog.com`. The policy then allows exactly that
  host and its `-assets` host (remote config); no script source is added, since the studio
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

## Turning the Mac app's reporting off

As in 1.x, any of these turns everything off, in the shell and the studio, before anything loads:
`PONZU_TELEMETRY=0`, `DO_NOT_TRACK=1`, `CI`, or `ponzu telemetry off` (`"enabled": false` in
`~/.ponzu/telemetry.json`). The app has no switch of its own in Settings yet.

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
