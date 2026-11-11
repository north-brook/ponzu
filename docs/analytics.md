# Analytics

Ponzu Cloud reports usage, session replays, errors and AI traces to PostHog, one project per
environment: the development stack (`api.ponzu.design` until cutover, the Ponzu Dev app) reports
to **Ponzu Dev**, and production will report to **Ponzu**. The pre-cloud product's telemetry
(`apps/cli`, `apps/mobile`, `apps/web`) reports to the old project and goes at cutover; nothing
here sends to it.

The server's rules and its events are the API's half of this file. This section is the app's:
the Mac app's studio (`apps/studio`) and shell (`apps/desktop`).

## App events

A fact is captured once, by the side that knows it for certain. The app captures what only it
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

## Pointing a build at a project

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

## Turning it off

As in 1.x, any of these turns everything off, in the shell and the studio, before anything loads:
`PONZU_TELEMETRY=0`, `DO_NOT_TRACK=1`, `CI`, or `ponzu telemetry off` (`"enabled": false` in
`~/.ponzu/telemetry.json`). The app has no switch of its own in Settings yet.

## What never leaves

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
