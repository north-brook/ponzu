# iPhone end-to-end tests

[Maestro](https://maestro.dev) flows that drive a Debug development client of
Ponzu Dev (`design.ponzu.app.dev`) on the iOS Simulator, against this
checkout's JavaScript from Metro, built with the in-app fake backend
(`PONZU_BACKEND=fake`, see [docs/mobile.md](../../../docs/mobile.md)). Nothing
reaches a real API, WorkOS or GitHub. They run in this order (`config.yaml`):

| Flow | What it checks |
| --- | --- |
| `launch.yaml` | A clean install: the slice and wordmark on yuzu, then Sign in, since nobody is. A link the build doesn't take opens nothing. |
| `sign-in.yaml` | Continue with GitHub through the system's auth session onto the fake's authorize page (`authorize.ts`), back on `ponzu-dev://auth/callback`; the canvases (Pricing page, Onboarding, Launch poster); settings from the lockup; Sign out back to Sign in. |
| `setup.yaml` | Lee, with nothing set up: Set up installs the GitHub App through the auth session onto the fake's install page (`authorize.ts /install`), back on `ponzu-dev://github/setup`, and the row turns Ready; Continue; Connect Claude with an API key; the canvases, with New canvas over them since Lee has none. |
| `canvases.yaml` | Maya's list in every state: the row waiting on her first, with its question; the working row; Settled folding the settled canvas away; holding a row to settle it; settings from the lockup switching to Northbrook, and usage with nothing to pay. |
| `new-canvas.yaml` | Sam, with no canvases: New canvas comes by itself, in Scratch, in the Mac's words; Send waits for a prompt, then makes the canvas and opens it. Maya: New canvas from the header, the picker grouped by workspace, and a repo in Northbrook moving the statement to it. |
| `canvas.yaml` | A canvas from its row (the fake's Pricing page): the web view draws it, the placeholder gives way, the title and the floating stack (Comment, Chat, no pull request); Back to the list. |
| `comment.yaml` | Comment, a tap on the Plans board, typed words, Send: the field leaves, the pin stays; tapping the pin opens its thread under Maya's name; Resolve closes it; the chat then shows the picture of where it was left, which the canvas page drew as it was sent. |
| `comment-modes.yaml` | A hold on the FAQ board brings the field up in voice, which says it can't hear (the microphone is refused); Type instead and Speak instead switch; typed words swiped away stay as an unsent pin, which brings the field back with them. |
| `chat.yaml` | The Pricing page's chat (seed `chat`): Maya's bubbles, Ponzu's reply from its Markdown, the aside and working line while the turn runs; words typed with the keyboard up and sent mid-run land as a bubble; Stop ends the turn ("You stopped it"); a swipe down closes the sheet; opened again, the reply's link to the Plans board closes it and focuses that board. |
| `needs-you.yaml` | The Pricing page waiting on Maya (seed `needs-you`): Chat says three questions wait; opened, the asks take the composer's place with the pager across four pages; a single choice, then a multi-select with a note typed with the keyboard up (Send stays on screen above it), the plan's first paragraph and then all of it with Approve, and the permission with Allow; once the last is sent the composer is back. |
| `pull-request.yaml` | The Pricing page's pull request (seed `pull-request`): the stack's button opens its sheet with Status (checks passed, Theo approved, two comments) and three files; the checks and a file's diff open inside the sheet and Back returns; Merge asks in the system's action sheet, Cancel merges nothing, Merge merges it and the button goes. |
| `search.yaml` | Search on the Pricing page's thread and a comment (seed `search`): before typing, the recent canvases, the Pricing page saying Claude is working; "pricing" finds the canvas by name; "plans" finds the Plans board and, under Threads, Maya's comment and her ask, pressable with the keyboard up; her ask opens the canvas with the chat up at it. |
| `pings.yaml` | On an API that sends pings (seed `pings`), with the app's data cleared and iOS not yet asked (`shared/start-fresh.yaml`): nothing asks at launch; the first comment brings the ask in onboarding's words; Turn on notifications brings iOS's prompt, and Allow closes the ask; Settings shows Notifications in the Mac's words. |

Then, unless `PUSH=0`, `run.sh` sends pings with `xcrun simctl push`
(`push/*.apns`, each as Expo's service delivers one, its data under `body`;
`push/payloads.test.ts` holds them to the fake's ids). While each flow in
`push/` runs, its ping is sent every two seconds. Maestro reads only the app's
own views, not iOS's banner over them, so a flow taps the banner where iOS
draws it, at the top of the screen. `warm-open.yaml` opens Onboarding, and
`warm-tap.yaml` taps the Pricing page's needs-you banner, which opens its chat
at that question. `foreground.yaml` taps where a banner would be while pull
request pings about the Pricing page, on screen, arrive: none shows, so the
pull request sheet never opens. `other-canvas.yaml` taps Onboarding's banner,
which opens Onboarding's chat. `cold-open.yaml` seeds the next launch
(`relaunch=1`) and ends the app, and `cold-tap.yaml` taps the permission
ping's banner over the home screen, which starts the app and, once Maya is
signed in, opens the chat at the permission.

With `REMOUNT=1` (`--env REMOUNT=1` on the job), `run.sh` then tests the remount iOS forces on a canvas: `remount/open.yaml`
opens the Pricing page and waits for its boards, `run.sh` ends that
simulator's WebContent process (found with `simctl spawn <udid> launchctl
list`, so no other simulator's is touched), and `remount/check.yaml` checks a
new web view draws the boards again under the same title with no placeholder.
`run.sh` fails if the process it ended is still there. It is opt-in because it
has not yet run on spare; once it passes there, make it the default.

`shared/start.yaml` opens the client onto Metro and closes the development
menu if it shows. `ponzu-dev://dev?seed=<scenario>` puts the fake in a state
(`lib/cloud/backend.fake.ts`: signed-out, signed-in, empty, github-reauth,
too-old, setup-where, setup-claude, canvases, chat, needs-you, pull-request, pings, search); only a fake build takes it. Every flow checks no development warning
("Cannot update a component…") is on screen.

Flows find views by `testID` (`id:` in Maestro) or by text: `launch`,
`sign-in`, `sign-in-github`, `sign-in-error`, `canvases`, `lockup`,
`canvas-<id>`, `tab-canvases`, `tab-search`, `search`, `settings`,
`settings-sign-out`, `update`, `setup-where`, `setup-account-<login>-set-up`,
`setup-where-continue`, `setup-claude`, `setup-claude-add-key`,
`setup-claude-key-field`, `setup-claude-connect`, `setup-code`, `settled`,
`settings-workspaces`, `settings-usage`, `new-canvas`, `new-canvas-project`,
`new-canvas-prompt`, `new-canvas-send`, `new-canvas-attach`, `new-canvas-model`,
`new-canvas-error`, `pick-project`, `pick-project-search`,
`pick-project-allow-more`, `connect-claude-sheet`, `canvas`, `canvas-web`,
`canvas-placeholder`, `canvas-gone`, `back`, `title`, `page-menu`, `stack-pr`,
`stack-comment`, `stack-chat`, `canvas-hint`, `comment-sheet`, `comment-field`,
`comment-input`, `comment-error`, `to-type`, `to-voice`, `send`, `thread-sheet`,
`resolve`, `thread-note`, `thread-read-only`, `draft-sheet`, `move-done`,
`chat-sheet`, `chat-thread`, `chat-input`, `chat-send`, `chat-stop`,
`chat-attach`, `chat-working`, `chat-waiting`, `chat-line`, `chat-read-only`, `chat-comment-picture`, `chat-comment-open`,
`stack-chat-badge`, `needs-you`, `needs-you-header`, `needs-you-pager`,
`needs-you-previous`, `needs-you-next`, `needs-you-option`, `needs-you-note`,
`needs-you-send`, `needs-you-plan`, `needs-you-read-plan`, `needs-you-blocked`,
`chat-pull-request`, `pr-sheet`, `pr-number`, `pr-open-github`, `pr-close`,
`pr-title`, `pr-checks`, `pr-reviews`, `pr-comments`, `pr-file`, `pr-back`,
`pr-check`, `pr-diff`, `pr-diff-none`, `pr-action`, `pr-failed`, `pr-note`,
`pr-foot-line`, `ping-ask`, `ping-ask-turn-on`, `ping-ask-not-now`,
`settings-notifications`, `settings-ping-this-iphone`, `canvases-notice`,
`search-recent`, `search-recent-<id>`, `search-results`,
`search-section-<canvases|boards|threads>`, `search-canvas-<id>`,
`search-<page|board>-<canvas id>-<id>`, `search-<message|comment>-<canvas
id>-<id>`, `search-searching`, `search-none`, `search-failed`. A
canvas's row reads as its VoiceOver label ("Pricing page, 1 waiting for you,
site, …"), so flows match it with a pattern. Give a new screen a `testID` named
after it.
Wait with `extendedWaitUntil`, never a fixed sleep.

## Run them

On spare, through the network-work job runner, never on a workstation. From
a checkout on a master, with its edits:

```sh
network job start spare --repo ponzu --source . --include-dirty \
  --agent command --resource ios -- scripts/ci/mobile-ios.sh
```

On a Mac with a booted simulator, Java 17 or later and the Maestro CLI
(`brew install openjdk@17`, `curl -fsSL "https://get.maestro.mobile.dev" | bash`):

```sh
apps/mobile/maestro/run.sh <udid>
```

It starts the authorize page and Metro (fake backend) on free ports, builds the
development client (`APP_VARIANT=dev expo prebuild`, `xcodebuild` Debug),
installs it, and runs every flow. Already running both, with the client
installed:

```sh
AUTH_PORT=8790 METRO_PORT=8095 SKIP_BUILD=1 apps/mobile/maestro/run.sh <udid>
```

When a flow fails, `~/.maestro/tests/<run>/` holds each step's result and
the view hierarchy it saw (`commands.json`) and a screenshot of the failure.

## Continuous integration

`Mobile iOS` in `.github/workflows/ci.yml` runs `run.sh` on spare's runners
for pull requests from this repository that `scripts/ci/scope.ts` says can
affect the phone, once the repository variable `MOBILE_IOS` is `true`. It
does not run for pull requests into `cloud` yet: it comes back there once
the cloud app's flows have passed twice on the job runner. The `Mobile` check
reports for every pull request either way.
