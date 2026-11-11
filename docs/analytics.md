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
  as the logs.

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
| `workspace connected` | `workspace_id`, `kind`, `repos` | The App was installed on an account, or installed again, or unsuspended. About whoever installed it, when Ponzu knows them. |
| `workspace disconnected` | `workspace_id`, `reason` (`uninstalled`, `suspended`) | About no one. |
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
| `turn finished` | `design_id`, `turn_id`, `outcome` (`completed`, `failed`, `stopped`), `error_code`, `duration_ms`, `tool_calls`, `models`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd` | As above. `turn_id` is also the turn's trace id in LLM analytics. A report sent twice is the same event (its id is made from the turn's). |
| `question asked` | `design_id`, `question_id`, `kind` | The agent asked; about no one. |
| `question answered` | `design_id`, `question_id`, `kind` | |
| `pull request created` / `merged` / `closed` | `design_id`, `number` | Once each, whichever of a route and a webhook sees it first. |
| `sandbox woke` | `design_id`, `start` (`new`, `cold`, `warm`), `duration_ms` | About the design's owner, whose Claude it runs on. |
| `sandbox slept` | `design_id`, `quiesced` | `quiesced`: its runner said it was ready before the stop. |
| `sandbox lost` | `design_id` | The provider lost the sandbox or its disk; the wake made a new one. |
| `sandbox restored` | `design_id`, `kind` (`rollback`, `rebuilt`) | A runner found its disk behind the last checkpoint. About no one. |
| `ideas generated` | `repo_id`, `count`, `duration_ms`, `attempts`, `input_tokens`, `output_tokens` | About whoever's visit started it. |
| `ideas skipped` | `repo_id`, `reason` (`rate_limited`, `rejected`, `failed`) | |
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

Every event carries `design_id`, the `workspace` group, `$ai_session_id` (the design id, so a
design's turns read as one conversation whatever Claude session each ran in), and `$session_id`
of the app session that sent the message, when it said. The distinct id is the person whose
message began the turn; a turn nobody's message began is about no one. With content on, the
prompt, the replies and the tools' arguments and results go too, each clipped to 16,000
characters; with it off those properties are null.

Why the runner sends them itself: it has the whole of Claude Code's message stream, which is
large with content on, and the API's functions answer in 4.5 MB from a region a hundred
milliseconds away. The token is public. A turn never waits on PostHog: its events are built when
it ends and put on posthog-node's bounded queue, which sends itself every few seconds; the runner
flushes it as it gets ready to sleep and as it stops (within a few seconds), so what a turn did
leaves before the machine does.

Why not `@posthog/ai`'s Claude Agent SDK integration: it fixes one trace id for a whole query
(the runner keeps one query per session, and its turns' ids are the results'), it cannot say per
turn who sent the message or from which app session, and it reads only the main thread's stream,
so subagents' model calls would be lost. The events are the documented manual-capture format.
