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
| `canvas.yaml` | A canvas from its row (the fake's Pricing page): the web view draws it, the placeholder gives way, the title and the floating stack (Comment, Chat, no pull request); Back to the list. |

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
too-old); only a fake build takes it. Every flow checks no development warning
("Cannot update a component…") is on screen.

Flows find views by `testID` (`id:` in Maestro) or by text: `launch`,
`sign-in`, `sign-in-github`, `sign-in-error`, `canvases`, `lockup`,
`canvas-<id>`, `tab-canvases`, `tab-search`, `search`, `settings`,
`settings-sign-out`, `update`, `canvas`, `canvas-web`, `canvas-placeholder`,
`canvas-gone`, `back`, `title`, `page-menu`, `stack-pr`, `stack-comment`,
`stack-chat`. Give a new screen a `testID` named after it.
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
