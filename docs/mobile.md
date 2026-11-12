# The iPhone app

`apps/mobile` is Ponzu for iPhone and iPad on Ponzu Cloud: sign in with
GitHub, see your workspace's canvases, watch Ponzu work on them, steer with
comments, and answer its questions ([docs/cloud.md](cloud.md), "Clients"). It
is an Expo app (SDK 58, React Native 0.88, Expo Router, NativeWind), iOS only.
Everything it says to Ponzu goes through `@ponzu/client`, on the React Native
side. Its design is `.context/cloud/program/designs/iphone.md`.

This is being rebuilt from the 1.x app, which talked to paired Macs over
Tailscale. That data layer, pairing, Tailscale and the camera are gone. What
is built so far: the native modules the cloud app needs, the two app
variants, the cloud seams (`lib/cloud/`), launch, sign-in, the update screen,
a plain list of canvases, and a settings sheet that signs out. Setup, the
canvas, comments and the rest arrive slice by slice.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | Screens, by Expo Router. `_layout.tsx` is the root; `+native-intent.tsx` reads every incoming link. |
| `lib/cloud/` | Everything that talks to Ponzu Cloud (below). |
| `lib/links.ts` | The one reader of links (below). |
| `lib/` | The rest: `tokens.ts` (the design's colors and fonts), `theme.ts`, `slice.tsx` (the mark and its bloom), `polyfills.ts`, `first-launch.ts`, `duo-layout.ts`, `dictation.ts`, `drafts.ts`, `haptics.ts`. |
| `components/` | Shared views: the canvas web view (`canvas-view.tsx`), the comment composer and sheets, the launch handoff, and `glass.tsx`, the floating controls' Liquid Glass. |
| `global.css` | Tailwind and the design's tokens as class names (`bg-yuzu`, `text-c-muted`, light and dark). |
| `canvas/` | The canvas web view's page, a browser bundle with its own tsconfig. |
| `maestro/` | End-to-end flows, against the fake backend. |
| `app.json`, `app.config.ts` | The app's config. Release Please bumps `app.json`'s version; `app.config.ts` makes the variant. |
| `eas.json`, `.eas/workflows/` | Builds and releases on EAS. |
| `metro.config.js`, `metro.resolve.js` | Metro, with the backend swap and one copy of React (below). |

`ios/` is generated (`expo prebuild`) and never committed.

### The imports rule

Files under `app/`, `lib/` and `components/` may import `@ponzu/core` and
`@ponzu/client`, any entry but `@ponzu/client/testing`, which only
`lib/cloud/backend.fake.ts` and tests may use. They never import
`@ponzu/canvas`, `@ponzu/render`, `@ponzu/server`, `@ponzu/db`,
`@ponzu/sandbox`, `@ponzu/tools`, `@ponzu/api` or `@ponzu/store`, and never
another package's source by path: those need a browser or Node, or bring a
second React. The one exception is `lib/page-icons.ts`, which reads
`packages/canvas/src/icon-names.ts` (pure data). `canvas/` is the browser page
and may import packages/canvas source by path. `imports.test.ts` checks it,
and `lib/polyfills.ts`, imported first, gives the client and core what Hermes
lacks.

`@ponzu/client` runs from source, and its own development copies of React and
TanStack Query sit beside it. Metro, like Node, would take those for its
imports, and a second React breaks every hook. `metro.resolve.js` makes
`react`, `react-native` and `@tanstack/react-query` resolve from the app
whoever imports them; the component tests' resolver does the same.

## Ponzu Cloud on the phone

`lib/cloud/` holds the seams, each small enough to read:

| File | What it does |
| --- | --- |
| `config.ts` | The API URL, the WorkOS client id, the variant and its scheme, the version: from `EXPO_PUBLIC_*` and the app config. |
| `backend.ts` | The real thing: one `createSession`, `createApi` and, per signed-in person, `createLive`. |
| `backend.fake.ts` | The in-app fake (below), in `backend.ts`'s place when the bundle is built with `PONZU_BACKEND=fake`. |
| `storage.ts`, `keychain.ts` | The session in the Keychain (below). |
| `crypto.ts` | `expo-crypto` as the client's `Randomness` (PKCE and checksums). |
| `files.ts` | A `KeyValueStorage` over files, for what is large and not secret (the offline canvases' `DocCache`). |
| `query.tsx` | `CloudProvider`: the signed-in person's QueryClient, its copy on disk, and their `Live`. |
| `persist.ts` | What of the cache goes to disk: an allow-list. |
| `gate.ts`, `use-gate.ts` | Where each session state sends the app. |
| `sign-in.ts`, `sign-out.ts` | Continue with GitHub; signing out in order. |
| `workspace.ts`, `canvases.ts` | The workspace in view, and its canvases. |

### Launch and the gates

The launch screen (`app/index.tsx`) blooms the slice on yuzu while the session
reads the Keychain, never leaves before the bloom has landed, then goes where
the session says (`gateRoute`): `signed_out` and `github_reauth` to sign-in
(the second with "Sign in again so Ponzu can reach GitHub."), `too_old` (a
426) to the update screen, `signed_in` to the canvases. After that,
`use-gate.ts` moves the app whenever the session leaves the screen's gate:
signed out here or elsewhere, a 426 anywhere, a sign-in. Still loading after
8 seconds, launch says "Can't reach Ponzu. Trying again." Setup's gates
(where you design, Claude) come between sign-in and the canvases with the
setup slice.

### Signing in

Continue with GitHub (`app/sign-in.tsx`, `lib/cloud/sign-in.ts`) is the
client's PKCE flow: `startSignIn`, then
`WebBrowser.openAuthSessionAsync(url, "<scheme>://auth/callback")` (the
system's auth session, which takes the redirect itself), `readRedirect`, and
`session.completeSignIn`. Closing the sheet, or saying no on GitHub, comes back
with nothing said; a failure is one line above the button. While the sheet is
up the button shows the turning slice and a second tap opens nothing. A
`<scheme>://auth/callback` that arrives as a link signs nobody in.

The client id is WorkOS staging's for Ponzu Dev. WorkOS must list
`ponzu-dev://auth/callback` among its redirects (a founder step). A build
with no client id says it can't sign in.

### The Keychain

The session lives in the Keychain through `expo-secure-store`, service
`design.ponzu.session`, readable after the phone's first unlock (so a push
handled in the background can read it) and never restored to another device
(`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`). `lib/cloud/storage.ts` adds:

- **Chunks.** Some iOS versions refused values over about 2 KB, and a session
  is about 2.5 KB. A value over 1,800 bytes is written as chunks
  `<key>.<gen>.<i>`, then a head at `<key>` naming the generation, then the
  old generation's chunks are deleted. A crash anywhere leaves the head naming
  chunks that are all there, so the value read is the old one or the new one,
  whole. The generation takes turns between 1 and 2, so whatever a crashed
  write left is always in the generation the head doesn't name, and the next
  write or delete sweeps it: no piece of a token outlives signing out. Calls
  run one at a time.
- **Reinstalls.** A Keychain item outlives deleting the app. The first launch
  without `Documents/.ponzu-installed` deletes the session, keeps the install
  id, and writes the marker, so a reinstalled phone starts signed out.
- **The install id.** 32 random hex characters (`Crypto.randomUUID()` without
  dashes) at `ponzu.installId`, made once and kept across reinstalls. It goes
  only to `POST /v1/me/devices`.

The unit tests prove these rules over a Map standing in for the Keychain.
Nothing yet proves them on a real Keychain: the simulator runs use the fake
backend, which never reads or writes the Keychain. That needs a real sign-in
in Ponzu Dev, or a device test of its own.

### The cache and offline

`CloudProvider` makes a QueryClient (`createQueryClient`) for each signed-in
person and drops it at sign-out, and keeps a copy on disk in AsyncStorage
(`ponzu.queries`, written at most every 2 seconds, kept 7 days, started again
for a new version or another person). Only what `persist.ts` names goes to
disk: `me`, a workspace, its canvases, a canvas's view, a pull request,
Claude's defaults, usage and notifications. Never a thread page or a
question; live queries cover those. The providers stay mounted whoever is
signed in, so a sign-in never remounts the screens under them. Signing out
shuts that person's persister before it removes the copy on disk, so a save
the 2-second throttle held back can't write their answers back afterwards.

`Live` is made for each signed-in person, paused when the app goes to the
background and resumed in front. Offline, it keeps the last rows.

### Signing out

From settings, each step tried whatever the one before did
(`lib/cloud/sign-out.ts`): this phone's device row (once pings have
registered one), the session, the cached answers in memory and on disk, the
live queries, the offline canvases and every `ponzu.*` AsyncStorage key but
the ping ask's and the cached images, analytics' identity (none yet), then
the sign-in screen.

### Links

`lib/links.ts` is the only reader of links: deep links (through
`app/+native-intent.tsx`), and later pushes and the links in a thread. A link
must use this build's own scheme, so `ponzu://` opens nothing in Ponzu Dev and
`ponzu-dev://` nothing in Ponzu. It takes:

- `canvas/<id>`, with `page`, `artboard`, `open` (`thread` opens the chat
  sheet, `pull-request` the PR sheet), `question`, `comment`, `message`;
- `design/<id>`, the same link as written before canvases had their name,
  kept for good;
- `github/setup?result=…&workspace=…`, `auth/callback`, `settings?section=…`;
- `https://ponzu.design/canvases/<id>`, a universal link, once the site serves
  the association file.

Anything else opens the launch screen, which goes where the session says; a
path the build has no screen for does the same (`app/+not-found.tsx`). The
grammar is `lib/link-grammar.ts`, a stand-in for `@ponzu/core/links` until
that lands, when `links.ts` imports core's instead.

### The fake backend

`lib/cloud/backend.fake.ts` is Ponzu Cloud in memory: the client's own
`createFakeBackend`, with Maya in the acme workspace (three canvases) and Sam
alone in an empty one. Metro puts it in `backend.ts`'s place when started with
`PONZU_BACKEND=fake` (`metro.config.js`), so a real build never carries it or
its test code. The component tests always use it.

Signing in on the fake goes through the real auth session when
`EXPO_PUBLIC_PONZU_FAKE_AUTHORIZE_URL` names a page that sends the browser
back with `code=fake` (`maestro/authorize.ts`); without one, the browser is
skipped. `ponzu-dev://dev?seed=<scenario>` (`app/dev.tsx`) puts the app in a
state: `signed-out`, `signed-in`, `empty`, `github-reauth`, `too-old`. Only a
fake build takes that link.

```sh
cd apps/mobile
APP_VARIANT=dev PONZU_BACKEND=fake bunx expo start --dev-client
```

## Variants

Two apps build from this project (`app.config.ts`, by `APP_VARIANT`):

| | Production | Ponzu Dev (`APP_VARIANT=dev`) |
| --- | --- | --- |
| Name | Ponzu | Ponzu Dev |
| Bundle id | `design.ponzu.app` | `design.ponzu.app.dev` |
| Scheme | `ponzu://` | `ponzu-dev://` |
| API | production's, at cutover | `https://api.ponzu.design`, WorkOS staging |
| Push tokens | production | development for the dev client, production for preview builds |
| Built by | `production.yml`, on a phone release | the development profile, and `preview.yml` by hand |

Both take universal links on `ponzu.design` (`associatedDomains`). Until
cutover only Ponzu Dev is installed from the `cloud` branch, so no cloud build
ever reaches a phone running the 1.x app or TestFlight's groups. The
`preview` profile is internal distribution on the `preview` channel and EAS
environment. `.eas/workflows/preview.yml` runs only by hand (`eas
workflow:run preview.yml`): agents never deploy, so nothing starts it on a
push.

## Floating controls

What floats over the canvas (back, the canvas's title, the page button, the
comment field, Resolve) is Liquid Glass (`expo-glass-effect`) on iOS 26, in
the app's light or dark; a control held open is the glass a step darker,
never a ring. Before iOS 26 it falls back to the design's bar: `--c-bar`, a
hairline and the pop shadow. `components/glass.tsx` has the rules: the glass
itself is never clipped, its content is.

## The comment field

A comment is written in one glass field and nothing else: no sheet around it.
It floats over the canvas, 8pt above the keyboard or clear of the home
indicator with the keyboard down, and rides the keyboard frame by frame
(`react-native-keyboard-controller`, `Sheet` with `bare` in
`components/sheet.tsx`); swiped down, it's cancelled. A thread's reply field
is the same field, in the thread's sheet.

Typed and said words go in the same field, five lines at most. Typing, it's
SwiftUI's own `TextField` (`@expo/ui`, vertical): SwiftUI grows it a line at
a time and scrolls it past five, and its host takes its height, so nothing in
JavaScript measures it. The mic inside its trailing edge switches to voice
until there are words, then Send takes its place. In voice, what's heard is
written into the field as it's said, on the phone (`expo-speech-recognition`);
the listening disc at its leading edge mutes, the keyboard glyph goes back to
typing, and a tap on what's been said goes back to typing with the words.

On iPhone Duo's inner display held sideways, and on an iPad, the field floats
centred over the canvas at most 560pt wide (`SHEET_MAX` in
`lib/duo-layout.ts`).

## iPhone Duo and iPad

Layouts follow the window's size, never the model (`lib/duo-layout.ts`), so
iPhone Duo's displays, an iPad and an iPad window in Stage Manager or Split
View all take the layout their space calls for. An iPhone keeps to portrait;
an iPad turns freely (`UISupportedInterfaceOrientations~ipad` in
`app.json`).

- **The canvas.** A window whose shorter side is under 600pt is a phone's:
  the canvas's own bar and the comment field. Otherwise the system's bars hold
  Back, the page and Comments. Comments are an inset panel beside the canvas
  in a window 900 points wide or more.
- **The sheet.** In any window 700pt or wider (an iPad), and on the inner
  display sideways, a sheet floats centred, at most 560pt wide (`sheetMax`),
  riding 8pt above the keyboard instead of docking into it.
- **The tabs** are named on an iPad, where the tab bar is a row of names
  across the top that VoiceOver reads by name; on an iPhone they're marks,
  together in one bar. Search is a plain tab, not the system's search tab
  (which iOS 26 sets apart from the bar).

## Haptics

One vocabulary, `lib/haptics.ts` (as augmenter's): each gesture gets one,
never a stream, and none for scrolling or for motion the person didn't
cause. They follow the system's haptics setting. In development each is
logged to Metro as `[haptic] <kind>`, since the simulator can't buzz.

| Haptic | When |
| --- | --- |
| `select` | A tab changing; a native menu opening; a page picked; typing ⇄ voice; settings opened from the lockup |
| `tick` | A canvas opened; Back; a board coming into focus or leaving it; a comment's pin dropped |
| `success` | A comment or reply sent; a thread resolved |
| `thud` | Sign out; a draft discarded |
| `fail` | A sign-in that failed; a comment that didn't send |

## Styling

Class names are NativeWind 5 (`nativewind@5.0.0-rc.0` with
`react-native-css@3.1.0-rc.0`, both pinned exactly) on Tailwind 4. The
compiler needs `lightningcss` 1.30.1: newer ones fail to deserialize
`global.css`. `apps/mobile` pins its own copy, and the web and studio keep
theirs. Light and dark follow the system through `@media
(prefers-color-scheme: dark)` in `global.css`. For a literal value (an SVG
fill, the status bar, a shadow), use `lib/tokens.ts`; `lib/tokens.test.ts`
keeps the two in step. Ink, never iOS blue.

Fonts are embedded in the binary by the `expo-font` plugin: Inter 400 to 700,
Funnel Display 700 and IBM Plex Mono 400 and 500. Set `fontFamily` to the
family (`font-sans`, `font-display`, `font-mono`) and `fontWeight` picks the
face. Adding a weight is a native change: add its file in `app.json` and
rebuild.

## How to run it

Native builds, the simulator and Maestro run on spare, through the
network-work job runner, never on a workstation (see
[`apps/mobile/maestro/README.md`](../apps/mobile/maestro/README.md)). What
runs anywhere:

```sh
bunx tsc -p apps/mobile/tsconfig.json --noEmit     # the app
bunx tsc -p apps/mobile/canvas/tsconfig.json --noEmit   # the canvas page
bun test apps/mobile                               # pure modules
cd apps/mobile && bun run test:rn                  # component tests (jest-expo)
cd apps/mobile && bunx expo export --platform ios  # the bundle
```

Component tests are `*.rntest.tsx` in `rntests/` (never in `app/`, where Expo Router
would bundle them as routes), rendered with
jest-expo and React Native Testing Library against the fake backend; `bun
test` skips them by their name. They stand in for the router (`jest.setup.js`)
and read where a screen sends the app from its calls.

A development client of Ponzu Dev for a registered phone comes from EAS
(`APP_VARIANT=dev eas build --profile development --platform ios`), signed
with the team's certificates; then `bunx expo start --dev-client` from
`apps/mobile`. Rebuild after any native change: a native dependency, a config
plugin, `app.json`'s `ios` section, a font. Every native change ships in one
batch (the fingerprint decides between an update and a build); this one added
expo-secure-store, expo-web-browser, expo-crypto, expo-clipboard,
expo-image-picker and expo-device, and removed expo-camera, the Tailscale
module and the App Transport Security exception.

## Releases

The phone is its own Release Please component. A `feat` or `fix` that touches
`apps/mobile` goes into a separate release PR (`chore(main): release mobile
X.Y.Z`), which merges itself like the Mac's once CI passes and tags
`mobile-vX.Y.Z`. Changes only under `apps/mobile` never bump the Mac app
(`exclude-paths` in `release-please-config.json`), and its release notes leave
them out. Nobody edits `apps/mobile/app.json`'s version or pushes a tag.

What a release ships depends on the native fingerprint (`runtimeVersion:
fingerprint`; `fingerprint.config.js` leaves the version out of it):

- **The same native code as an existing build:** an over-the-air update to
  that build's channel. Installed apps pick it up at their next launch.
  A build installed later still carries its own release's JavaScript, so
  its first launch fetches the current release behind the splash and
  restarts into it, waiting at most six seconds (`lib/first-launch.ts`).
- **New native code** (a native dependency, a plugin, `app.json`'s native
  config, a font): a new build, sent to TestFlight.

`apps/mobile/.eas/workflows/production.yml` does this on every `mobile-v*`
tag, looking up a build by fingerprint first. There is one lane: every
TestFlight build is a `production` build, and every installed phone listens
on the `production` channel. A new build reaches TestFlight's internal
**Team** group at once (the group distributes every build automatically, with
no review) and the external **Alpha** group through Beta App Review. Release
PRs merge themselves once CI passes, and the tag starts the workflow: a
JavaScript-only change under `apps/mobile` is an update a few minutes after
it merges, which installed phones pick up at their next launch, while one
that changes native code waits for its build to reach TestFlight.

Release Please releases the phone only for changes under `apps/mobile`, but
the phone also bundles `packages/core`, and the canvas and icons import
`packages/canvas`'s and `packages/render`'s source. `shared.yml` covers those:
a push to `main` touching them (or `patches/**` or `bun.lock`) publishes
`main` as an update on the same `production` channel, and never builds. A
native change there reaches no phone until the next phone release builds
for it.

Updates are published to the build profile's `channel` in `eas.json`, which
EAS maps to the branch of the same name; `eas channel:view production` shows
the mapping. A channel pointing at no branch serves nothing, so installed
phones never update: link it with `eas channel:edit production --branch
production`.

EAS owns build numbers (`appVersionSource: remote`, `autoIncrement`). Run a
workflow by hand with `eas workflow:run production.yml` from `apps/mobile`.

The GitHub release for `mobile-vX.Y.Z` holds the changelog only and is
published without becoming the repository's latest release, which stays the
Mac app's (its updater and the site's download link read that).

### Release notes

Notes come from the PR's `## Release note` section, as for the Mac
([release-notes.md](release-notes.md)). In a PR that changes both apps, start
a note with `Mac:` or `iPhone:` to say which app it's about. The Mac's What's
new leaves out `iPhone:` notes and every commit that changed only
`apps/mobile`. A release that builds a new binary sends its notes to
TestFlight as What to Test (`scripts/release-notes.ts --phone`, run by
`production.yml`): its `iPhone:` notes and the unlabelled notes of commits
that changed only `apps/mobile`.

### Accounts and secrets

- **Expo:** project `@north-brook/ponzu`
  (`67e319ee-49ff-45aa-8029-28c78f63041e`), owner `north-brook`. The EAS
  GitHub integration starts the workflows: the repository is linked under the
  project's GitHub settings, with `apps/mobile` as its base directory.
- **Apple:** team `R9352YFQL4`. EAS manages the distribution certificate and
  the App Store provisioning profile (`eas credentials`). Submissions use the
  App Store Connect API key `3UDC454AX2`, set on the project's iOS
  credentials.
- **App Store Connect:** the app is "Ponzu: AI Canvas", Apple ID
  `6827217192` (`ascAppId` in `eas.json`). TestFlight has two groups: the
  internal **Team**, which gets every build automatically, and the external
  **Alpha**, which `production.yml` names. External testing needs the test
  information (description, feedback email, privacy policy
  `https://ponzu.design/privacy`) and Beta App Review's contact details,
  filled in under TestFlight > Test Information.
- **EAS environment variables:** `EXPO_PUBLIC_POSTHOG_KEY` (and optionally
  `EXPO_PUBLIC_POSTHOG_HOST`) in `production` only, so development builds
  send nothing. `POSTHOG_CLI_API_KEY` (secret) and
  `POSTHOG_CLI_PROJECT_ID` (PostHog project `677204`) there too upload
  source maps: from production builds through PostHog's build plugin in
  `app.config.ts`, and from production updates through
  `eas/posthog_upload_sourcemaps` in `production.yml`.

## Checks

`bun run typecheck` and `bun test` at the root cover the app. CI's `Test
scope` job (`scripts/ci/scope.ts`) decides what a pull request can affect;
`Mobile checks` (typecheck, tests, component tests and `expo export
--platform ios`) runs when it touches the phone or what it runs (the canvas,
`@ponzu/client`, `@ponzu/core`), for pull requests into `cloud` too, and
`Mobile` reports for every pull request. `Mobile iOS` runs the Maestro flows
on spare's runners, for pull requests into `main` only until the cloud app's
flows have passed twice on the job runner; see
[`apps/mobile/maestro/README.md`](../apps/mobile/maestro/README.md).
