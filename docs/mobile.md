# The iPhone app

`apps/mobile` is Ponzu for iPhone: browse your designs, watch agents work and
comment, from your phone. It talks straight to the Ponzu server on each of
your Macs over your Tailscale tailnet. It's an Expo app (SDK 58, React Native
0.88, Expo Router, NativeWind), iOS only, with the same bundle id as the Mac
app, `design.ponzu.app`. The design it builds from is the spec; see the iPhone
design's `notes/brief.md`.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | Screens, by Expo Router. `_layout.tsx` is the root. |
| `lib/` | Shared code: `tokens.ts` (the design's colors and fonts), `theme.ts`, `slice.tsx` (the mark and its bloom), `ua.ts` (the User-Agent), `polyfills.ts`; and the data layer (see below): `query.tsx` and `mac-queries.ts` (the query cache), `macs.ts` (paired Macs), `reach.ts` (who answers), `catalog.ts` (every Mac's designs), `design.ts` (one design's socket), `seen.ts`, `activity.ts`, `telemetry.ts`. |
| `components/` | Shared views: the file card, the canvas web view (`canvas-view.tsx`), the comment composer and sheets, and `glass.tsx`, the floating controls' Liquid Glass. |
| `global.css` | Tailwind and the design's tokens as class names (`bg-yuzu`, `text-c-muted`, light and dark). |
| `modules/bonjour` | A small Expo module that browses for `_ponzu._tcp` with Network.framework. |
| `canvas/` | The canvas web view's page, a browser bundle with its own tsconfig. |
| `maestro/` | End-to-end flows. |
| `app.json`, `app.config.ts` | The app's config. Release Please bumps `app.json`'s version. |
| `eas.json`, `.eas/workflows/` | Builds and releases on EAS. |

`ios/` is generated (`expo prebuild`) and never committed.

Code here may import `@ponzu/core`, never `@ponzu/react`, `@ponzu/render` or
`@ponzu/server`, which need a browser or Node. `lib/polyfills.ts`, imported
first, gives core what Hermes lacks.

### Data

What the phone asks a Mac for goes through one TanStack Query cache
(`lib/query.tsx`), keyed per Mac (`lib/mac-queries.ts`): `["mac", id,
"info"]` (`/api/info`), `["mac", id, "macs"]` (`/api/macs`), `["mac", id,
"catalog"]` (its designs) and `["mac", id, "activity"]` (`/api/activity`,
what agents changed). Info, catalogs and activity are kept in AsyncStorage
for a week (dropped on a new version or protocol), so the app opens onto the
last list and an asleep Mac keeps its cards, dimmed. While a Mac answers, its
catalog socket (`/api/catalog/stream`) writes the snapshot and each patch
into its catalog query; nothing else holds a copy. Search, Activity and the
cards are read from those queries. Activity asks each Mac again when the
app comes back to the foreground and when its catalog stream says an agent
edited a design.

Each Mac keeps a history of what agents changed (`packages/server/src/changes.ts`):
an agent's edits to artboards in one design, a couple of minutes apart at
most, are one change ("Claude changed 12 artboards"), with the artboards and
whether they were added, removed or changed. The last 200 per design live in
the catalog database (`~/.ponzu/ponzu.db`), so a restart keeps them. Pairing and shelf changes (`POST
/api/shelf`, by holding a card) are mutations; a shelf change moves the card
at once and puts it back if the Mac refuses.

Live state stays in small stores (`lib/store.ts`): who answers and the wake
knock (`reach.ts`, which asks for info through the query cache), which
catalog sockets are open, the paired Macs (kept on the phone, never asked
for), what you've seen, and the open design's socket (`design.ts`). Preview
images are files in `Documents/cache` (`lib/cache.ts`), not in the query
cache.

### Floating controls

What floats over the canvas and on pushed screens (back, the title pill, the
agent's mark and its card, the bell, the hint and focus pills, the comment
sheet's round buttons) is Liquid Glass (`expo-glass-effect`) on iOS 26, in
the app's light or dark. Before iOS 26 it falls back to the design's bar:
`--c-bar`, a hairline and the pop shadow. `components/glass.tsx` has the
rules: the glass itself is never clipped, its content is.

### The comment sheet

A comment or reply is written by voice or typing in one sheet that changes
shape between them (the design's Flow › 8 ⇄ 7), never two screens. Every part
stays mounted and moves on one Reanimated clock on the UI thread; the timing
of each part, both ways, is in `lib/morph.ts`. The sheet's own shape (its
corners, side insets and bottom edge) follows the keyboard's frame, read
every frame from `react-native-keyboard-controller`, so it rides the
keyboard down and up with the system's animation, interactive dismissal
included. The mic, keyboard and send glyphs are SF Symbols (`expo-symbols`),
the round buttons interactive glass, and switching taps a selection haptic,
sending a light one.

### Styling

Class names are NativeWind 5 (`nativewind@5.0.0-rc.0` with
`react-native-css@3.1.0-rc.0`, both pinned exactly) on Tailwind 4. The
compiler needs `lightningcss` 1.30.1: newer ones fail to deserialize
`global.css`. `apps/mobile` pins its own copy, and the web and studio keep
theirs. Light and dark follow the system through `@media
(prefers-color-scheme: dark)` in `global.css`. For a literal value (an SVG
fill, the status bar, a shadow), use `lib/tokens.ts`; `lib/tokens.test.ts`
keeps the two in step.

Fonts are embedded in the binary by the `expo-font` plugin: Inter 400 to 700,
Funnel Display 700 and IBM Plex Mono 400 and 500. Set `fontFamily` to the
family (`font-sans`, `font-display`, `font-mono`) and `fontWeight` picks the
face. Adding a weight is a native change: add its file in `app.json` and
rebuild.

## Run it in the simulator

```sh
cd apps/mobile
bunx expo run:ios --device "iPhone 17 Pro"
```

That prebuilds `ios/`, builds a development client, installs it and starts
Metro. After the first build, `bun run dev` starts Metro alone, and the
installed client finds it. Rebuild (`bunx expo run:ios`) after any change to
native code: a new native dependency, a config plugin, `app.json`'s `ios`
section, a font, or `modules/`.

A Mac running Ponzu on the tailnet is what the app talks to; the simulator
uses the Mac's own Tailscale.

To try a branch's server while the installed Ponzu holds port 7777, run it
on another port and point the app at it in `apps/mobile/.env.local`:

```sh
PONZU_TELEMETRY=0 PONZU_BONJOUR=0 bun apps/cli/src/index.ts serve examples/*.design --port 7792
echo EXPO_PUBLIC_PONZU_DEV_HOST=127.0.0.1:7792 > apps/mobile/.env.local
```

Development builds save it as a paired Mac ("This Mac") and learn your other
Macs from it. Screens open by URL, with `xcrun simctl openurl booted
ponzu://<route>`: `designs`, `search?q=kettle`, `activity`, `connect`,
`connect/scan`, `tailscale`, `asleep`, `pair?host=<name>&v=1`, and a design
with `design/<mac id>/<encoded key>?page=App` (`thread=<id>` opens a thread,
`artboard=<id>` focuses a frame). In development a design also takes
`comment=<artboard>` (opens a new comment's sheet on that board) and
`uncomment=<text>` (deletes your threads that start with it), and
`activity?since=<ms>` shows what's new since then. `dev?forget=all` forgets
every Mac, for a first launch; `forget=dev` or `forget=<id>,<id>` forgets
those.

## On your iPhone, over the tailnet

Build a development client for your phone once, with EAS (it signs with the
team's certificates):

```sh
cd apps/mobile
eas build --profile development --platform ios
```

Install it from the link EAS prints. Then start Metro so the phone can reach
it over Tailscale, not just the Wi-Fi:

```sh
bunx expo start --dev-client --host tunnel   # anywhere, through Expo's tunnel
# or, with the phone on your tailnet:
REACT_NATIVE_PACKAGER_HOSTNAME=<this mac>.<tailnet>.ts.net bunx expo start --dev-client
```

and open the URL Metro prints in the development client.

## Reaching a Mac

The app asks each Mac's Ponzu at `http://<MagicDNS name>:7777`. It is plain
http: the tailnet already encrypts and authenticates the connection, and the
Mac answers by Tailscale identity. iOS's App Transport Security allows plain
http only to `*.ts.net` (an exception domain in `app.json`) and to the local
network. A raw tailnet address (`100.x.y.z`) can't be an exception domain, so
the app always uses a Mac's MagicDNS name, which `/api/info`, `/api/macs`, the
Bonjour advertisement and the pairing code all carry. Don't widen this to
`NSAllowsArbitraryLoads`.

Every request and socket sends `User-Agent: Ponzu-iOS/<version>` (`lib/ua.ts`);
the server tells the phone from a browser by it.

On the same Wi-Fi the app finds Macs by Bonjour (`_ponzu._tcp`, with the Mac's
MagicDNS name in the TXT record's `host`). The first browse shows iOS's local
network prompt; `useBonjour()` reports `denied` if it's refused.

## Releases

The phone is its own Release Please component. A `feat` or `fix` that touches
`apps/mobile` goes into a separate release PR (`chore(main): release mobile
X.Y.Z`), which merges itself like the Mac's once CI passes and tags
`mobile-vX.Y.Z`. Changes only under `apps/mobile` never bump the Mac app
(`exclude-paths` in `release-please-config.json`), and its What's new leaves
them out. Nobody edits `apps/mobile/app.json`'s version or pushes a tag.

What a release ships depends on the native fingerprint (`runtimeVersion:
fingerprint`; `fingerprint.config.js` leaves the version out of it):

- **The same native code as an existing build:** an over-the-air update to
  that build's channel. Installed apps pick it up at their next launch.
- **New native code** (a native dependency, a plugin, `app.json`'s native
  config, a font): a new build, sent to TestFlight.

Two EAS workflows (`apps/mobile/.eas/workflows`) do this, each looking up a
build by fingerprint first:

| Workflow | Runs on | Channel | A new build goes to |
| --- | --- | --- | --- |
| `preview.yml` | a push to `main` touching `apps/mobile`, `packages/core` or `bun.lock` | `preview` | TestFlight, internal testers |
| `production.yml` | a `mobile-v*` tag | `production` | TestFlight's external **Alpha** group, through Beta App Review |

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
`apps/mobile`.

### Accounts and secrets

- **Expo:** project `@north-brook/ponzu`
  (`67e319ee-49ff-45aa-8029-28c78f63041e`), owner `north-brook`. The EAS
  GitHub integration starts the workflows; link the repository under the
  project's GitHub settings, with `apps/mobile` as its base directory.
- **Apple:** team `R9352YFQL4`. EAS manages the distribution certificate and
  provisioning profile (`eas credentials`). TestFlight needs an App Store
  Connect API key on the Expo account and an external group named `Alpha`.
- **EAS environment variables:** `EXPO_PUBLIC_POSTHOG_KEY` (and optionally
  `EXPO_PUBLIC_POSTHOG_HOST`) in `production` only, so preview and
  development builds send nothing. To upload source maps from production
  builds, add `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID` there too
  (they turn on PostHog's build plugin in `app.config.ts`).

### Adding the App Store Connect app

There is no App Store Connect app yet. Once there is, add its Apple ID to
`eas.json` so `submit` and `testflight` jobs don't ask:

```json
"submit": {
  "preview": { "ios": { "ascAppId": "<Apple ID>" } },
  "production": { "ios": { "ascAppId": "<Apple ID>" } }
}
```

The Apple ID is the number under App Information in App Store Connect.

## Checks

`bun run typecheck` and `bun test` at the root cover the app. CI's `Test
scope` job (`scripts/ci/scope.ts`) decides what a pull request can affect;
`Mobile checks` (typecheck, tests and `expo export --platform ios`) runs when
it touches the phone or what it bundles, and `Mobile` reports for every pull
request. `Mobile iOS` runs the Maestro flows on the self-hosted Macs
(`apps/mobile/maestro/run.sh <simulator>` runs them here); see
[`apps/mobile/maestro/README.md`](../apps/mobile/maestro/README.md).
