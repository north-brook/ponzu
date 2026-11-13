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
a plain list of canvases, a settings sheet that signs out, and a canvas, live
and read only. Setup, comments and the rest arrive slice by slice.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | Screens, by Expo Router. `_layout.tsx` is the root; `+native-intent.tsx` reads every incoming link. |
| `lib/cloud/` | Everything that talks to Ponzu Cloud (below). |
| `lib/canvas/` | A canvas on the phone: its replica, the bridge to the page, how the page loads, and what the screen shows (below, "The canvas"). |
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
| `config.ts` | The API URL, the WorkOS client id, the variant and its scheme, the version: from `EXPO_PUBLIC_*` and the app config. Only Ponzu Dev has a default API (`https://api-dev.ponzu.design`); a production build with no `EXPO_PUBLIC_PONZU_API_URL` refuses to start (`apiUrlOf`) rather than talk to it. |
| `backend.ts` | The real thing: one `createSession`, `createApi` and, per signed-in person, `createLive`. |
| `backend.fake.ts` | The in-app fake (below), in `backend.ts`'s place when the bundle is built with `PONZU_BACKEND=fake`. |
| `storage.ts`, `keychain.ts` | The session in the Keychain (below). |
| `crypto.ts` | `expo-crypto` as the client's `Randomness` (PKCE and checksums). |
| `files.ts` | A `KeyValueStorage` over files, for what is large and not secret (the offline canvases' `DocCache`). |
| `query.tsx` | `CloudProvider`: the signed-in person's QueryClient, its copy on disk, and their `Live`. |
| `persist.ts` | What of the cache goes to disk: an allow-list. |
| `gate.ts`, `use-gate.ts`, `use-setup.ts` | Where each session state, and each setup step, sends the app. |
| `install.ts` | Installing the GitHub App: the install page in the auth session, and asking the API how it stands. |
| `sign-in.ts`, `sign-out.ts` | Continue with GitHub; signing out in order. |
| `workspace.ts`, `canvases.ts`, `list.ts` | The workspace in view, its canvases, and the list's pure rules (below). |
| `usage.ts` | The workspace's usage this period, read only, from the shared billing rules. |

### Launch and the gates

The launch screen (`app/index.tsx`) blooms the slice on yuzu while the session
reads the Keychain, never leaves before the bloom has landed, then goes where
the session says (`gateRoute`): `signed_out` and `github_reauth` to sign-in
(the second with "Sign in again so Ponzu can reach GitHub."), `too_old` (a
426) to the update screen, `signed_in` to setup's next step or the canvases. After
that, `use-gate.ts` moves the app whenever the session or setup leaves the
screen's gate: signed out here or elsewhere, a 426 anywhere, a sign-in, a
setup step done here or on the Mac. Still loading after 8 seconds, launch says
"Can't reach Ponzu. Trying again."

Signed in, where setup stands comes from `GET /v1/me` (kept on disk, so an
offline launch still knows), by the Mac's own gates
(`phoneSetupStep` in `@ponzu/client/model/setup`) with the iPhone step taken
as done: the phone is the iPhone. Until `me` answers, the screen on show stays
(the sign-in button keeps turning). When `me` can't be had and there is none on
disk, launch and the gate both go on to the canvases (`gateStep`), and move on
to setup once `me` answers.

### Setup

Two steps, each a screen with two progress bars, in the Mac's current words
(`lib/copy.ts`; `lib/copy.test.ts` reads the studio's setup screens and fails
when the two differ). The Claude card's states and failures are shared
outright (`@ponzu/client/model/claude-entry`), as are the account rows' labels
and the gates.

- **Where do you build?** (`app/setup/where.tsx`): GitHub is synced as the
  step opens, then the person's own account and each organization with Ponzu.
  Set up opens GitHub's install page in the system's auth session
  (`lib/cloud/install.ts`) on `<scheme>://github/setup`. While it is open the
  app asks `GET /v1/github/installs/:id` every 2 seconds; whichever comes first,
  the setup page's link or a settled answer (which closes the sheet), is the
  outcome, and GitHub is synced again however it ended. "Don't see an
  organization? Grant access on GitHub" opens GitHub's own install page the
  same way, as the Mac does. Continue records the step. A quiet Sign out sits
  under it.
- **Connect Claude** (`app/setup/claude.tsx`): Sign in starts a claude.ai
  sign-in, pushes the code screen and opens claude.ai in Safari. Add key turns
  the card into a secure field. **Paste the code** (`app/setup/code.tsx`) has
  iOS's paste control at the field's edge (no paste alert; nothing is read
  without a tap), every failure in the Mac's words, Open sign-in again, and
  Change, which lets the sign-in go, as leaving the screen does. Once Claude is
  connected, here or on the Mac, the live `me` row moves the app to the
  canvases.

`app/github/setup.tsx` takes the setup page's link when it reaches the app
outside the auth session, hands it to "Where do you build?" if that is on
screen (or syncs itself), and goes back.

### The canvases list

The Canvases tab is the Mac sidebar at phone size (`components/canvas-list.tsx`,
`components/canvas-row.tsx`, `lib/cloud/list.ts`):

- **Rows** come from the live query `workspace.canvases`, painted first from
  `GET /v1/workspaces/:id/canvases` kept on disk, so the list opens offline
  onto the last rows, as they were and not dimmed. They are mapped through the
  shared `toSummary` and ordered by the shared `orderCanvases`: on a team,
  canvases waiting on the viewer first, then newest activity.
- **A row** is the Mac's three lines beside a 64×48 preview: the repo (or
  Scratch) with one indicator at its end, the name, then the branch (or
  Scratch's place) with the pull request's number. The indicator is the
  shared `rowIndicator`: the needs-you count in a yuzu pill, else the turning
  slice while the agent works or wakes, else a yuzu dot for something new.
  While a canvas waits on the viewer, its third line is the first open
  question, named as the Mac's needs-you strip names it. Questions are watched
  live (`canvas.questions`) for at most 8 rows, the top needs-you ones.
- **Previews** are `<assetsUrl>previews/<previewSeq>-<light|dark>.png`, in the
  phone's appearance, through `expo-image` with its disk cache. `assetsUrl`
  comes from `GET /v1/canvases/:id`, asked once for each canvas that has a
  preview and kept on disk with the list.
- **A press** opens `/canvas/<id>` (`lib/canvas/open.ts`). **Holding** a row
  opens the system's action sheet with Settle, or Reopen in the tray, and
  Cancel; the live row then moves it. (Not `@react-native-menu`'s held menu
  around the row: on iOS its context menu interaction kept the row's taps, so
  a press never opened the canvas.) A failure says "“name” couldn't be changed. Try again.", as
  the Mac does.
- **Settled** canvases fold into a tray at the foot, closed until tapped,
  most recently settled first, with no indicators.
- While nothing has come the rows' shapes stand in, in the chip colour, and
  the lockup's slice juices. A workspace with no canvases shows a faint trace
  of rows and "No canvases yet. Canvases you make in Ponzu show up here."

The workspace in view is kept per person (`ponzu.workspace.<userId>`) and is
one choice for the whole app (`lib/cloud/workspace.ts`): settings lists the
person's usable workspaces when there are more than one, and picking one moves
the list under it at once and on the next launch. Settings also shows the
workspace's usage this period, read only: the total, the Mac's line under it
and the bar, with nothing to raise, add or pay, and no word sending anyone to
pay elsewhere.

### New canvas

New canvas (`app/new.tsx`) is a full screen pushed over the list from the
header's New canvas, with only the glass back button. It says what the Mac's
create page says (`lib/copy.ts`; `lib/copy.test.ts` reads the studio's create
page, composer, pickers and Claude dialog): the slice, then "Make something
in" over the repo's `owner/name`, or "Make something from" over "scratch",
and the composer's "Describe what you want to make". The rules are pure, in
`lib/cloud/create.ts`; the canvas's first name comes from the shared
`nameFor` (`@ponzu/client/model/create`), as on the Mac.

- **The project** starts on the repo the person pushed to last, or Scratch
  when they can push to none; the control under the statement opens **Pick a
  project** (`app/pick-project.tsx`, a sheet): a search, then a group for each
  usable workspace (the person's own first, each headed by its name when there
  is more than one), each its Scratch and then its repos, pushed to lately
  first, the chosen one ticked. Picking a project in another workspace moves
  the whole app to that workspace (`lib/cloud/workspace.ts`), as the Mac's
  picker does. "Allow more on GitHub" at the foot opens GitHub's install page
  in the auth session, and GitHub is synced however it ends. The pick and the
  prompt being written are held in memory (`lib/cloud/new-canvas.ts`) until
  sent or signed out.
- **The composer** (radius 26) holds Attach (the photo library, as JPEG), the
  model and effort (`components/model-sheet.tsx`: the system's menu with the
  models, then the efforts the chosen one takes; the last pick is kept at
  `ponzu.create.model`, an id), and Send, yuzu once there is a prompt and the
  project is known.
- **Send** makes the canvas with its first message in one call, in the chosen
  repo or Scratch, on the model and effort shown, then replaces New canvas
  with `/canvas/<id>`. Each composition carries one create key (a UUID), and a
  tap while one is on its way does nothing, so a double tap makes one canvas.
  With photos the canvas is made first, they go up, then the message says
  them; if that fails the canvas stays, the line says so, and sending again
  goes to the same canvas. A key once sent without its message always says
  the message itself afterwards, so a canvas made whose answer was lost still
  hears it. A new project gets a new key.
- **What stops a send**, read from `me` (Send waits for it, unless it can't be
  had, when the API answers the send itself): a Claude never connected, run out or
  signed out opens the Claude card as a sheet, titled and worded as the Mac's
  dialog, and the kept prompt goes once Claude is connected; Cancel sends
  nothing. A plan at its limit asks first, "Your Claude plan resets at
  <time>. Ponzu sends this then.", with Send then and Cancel: Send then makes
  the canvas, which waits for the plan. A send that fails says why in the
  Mac's words under the composer and keeps the prompt, photos and project. At
  a billing limit (402) the line is only the API message's first sentence:
  the workspace's state, never a word about paying.

Someone through setup whose workspace has no canvases yet gets New canvas
over the list by itself, once per person on this phone
(`lib/cloud/use-first-canvas.ts`, `ponzu.firstCanvas.<userId>`).

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

Before the session first reads the Keychain, the reinstall wipe runs once.
If it fails (the Keychain locked, the marker unwritable), the next call tries
again: one failed write never fails every Keychain call after it.

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
grammar is `@ponzu/core/links`, the one the Mac and the API share, and
`lib/links.ts` is the only file that imports it.

### The fake backend

`lib/cloud/backend.fake.ts` is Ponzu Cloud in memory: the client's own
`createFakeBackend`, with Maya in the acme workspace (three canvases) and Sam
alone in an empty one, both through setup with Claude connected. Metro puts it in `backend.ts`'s place when started with
`PONZU_BACKEND=fake` (`metro.config.js`), so a real build never carries it or
its test code. The component tests always use it.

Signing in on the fake goes through the real auth session when
`EXPO_PUBLIC_PONZU_FAKE_AUTHORIZE_URL` names a page that sends the browser
back with `code=fake` (`maestro/authorize.ts`); without one, the browser is
skipped. `ponzu-dev://dev?seed=<scenario>` (`app/dev.tsx`) puts the app in a
state: `signed-out`, `signed-in`, `empty`, `github-reauth`, `too-old`,
`setup-where` (Lee, whose own account has no Ponzu yet), `setup-claude`
(Ava, with no Claude), `canvases` (Maya's list in every state), `chat`
(the Pricing page's thread with a turn running) and `needs-you` (the Pricing
page waiting on two questions, a plan and a permission). Only a fake build takes that
link. With the authorize
page running, the fake's install links open its `/install` page, which comes
back as a finished install. A component test can put the person's Claude plan
at a limit with `backend.limitClaude(until)`.

```sh
cd apps/mobile
APP_VARIANT=dev PONZU_BACKEND=fake bunx expo start --dev-client
```

In the fake, Maya's "Pricing page" has two boards, so the canvas has
something to draw.

## The canvas

A row opens `app/canvas/[id].tsx` (`lib/canvas/open.ts`), and so do links
and, later, pushes, with `page`, `artboard`, `sheet`, `question`, `thread` and
`message`. Comments and the chat work (below); the pull request sheet comes
with its own slice.

- **The replica is on the React Native side.** `lib/canvas/use-canvas.ts`
  opens a `CloudSource` (`@ponzu/client/canvas`) for the signed-in person,
  with the offline `DocCache` in `Documents/cache/docs`, and closes it when
  the screen goes. The web view only draws: it holds no token and calls no
  API. iOS ends a web view's process in the background, and a replica there
  would lose what it hadn't sent.
- **The bridge** (`lib/canvas/bridge.ts`) tells the page each op the replica
  hears, so an agent's work develops in as on the Mac, and sends the whole
  doc whenever an op can't say what changed: the first load, the cached copy,
  a resync, a refused op rolled back, or someone else's op landing under one
  of the person's own before the API answered it. When the page loads again
  after iOS ended it, it says `ready` and gets everything.
- **Where the page loads from.** Its base URL is the canvas's `assetsUrl`, so
  every file a board loads is same-origin. A content security policy in the
  page runs only its own script, pinned by hash; the app fills in the asset
  origin before it loads the page (`lib/canvas/page.ts`), and the web view
  never navigates. `apps/mobile/canvas/README.md` has the details.
- **What the screen shows** (`lib/canvas/status.ts`), from the canvas's live
  head row and the replica's state: waking (the title shimmers, "Waking up"
  under it), working (the agent's boards ringed, the title shimmering),
  needs you (a count on Chat), asleep (quiet), offline ("You're offline.
  This is the last copy Ponzu had.") and gone ("That canvas isn't available to
  you." with Back). A board being worked on gets the yuzu ring alone, on a
  pure white or pure black ground.
- **Chrome.** Back, the canvas's name in a glass pill, the page button with
  the pages' native menu, and the floating stack bottom right: the pull
  request (once there is one), Comment, and Chat (the shared `railSignal`: the
  needs-you count, else the turning slice while the agent wakes or works).
  Chat opens the chat sheet. The pull request sheet isn't built yet, so its
  button says so when pressed. The needs-you count sits in a yuzu pill on
  Chat's top-right edge, and Chat's VoiceOver label says it ("Chat, Ponzu has
  2 questions"). A double-tapped board has the
  screen and the chrome steps aside.
- **Proofs.** `bun test apps/mobile/lib/canvas` runs the bridge over the real
  `CloudSource` and the client's fake backend, with a stand-in page that
  applies what it's sent as the real one does. `canvas/page.webkit.test.ts`
  loads the built page in Playwright's WebKit from a local origin standing in
  for R2: it draws, applies ops, loads files same-origin, rings a working
  board and refuses an injected script. `rntests/canvas-stack.rntest.tsx`
  covers the stack's states. A WebContent kill on a simulator, and the canvas
  on a phone, are proven only on the job runner or a device.

### Comments

Comments are left where they're about (iPhone design §8). Hold on the canvas,
or press Comment and then tap (the page drops the pin where the tap lands,
`commenting` in `canvas/protocol.ts`), and the comment field floats up, in
voice or typing as last used. A pin opens its thread's sheet: the messages
under their authors' names, a reply field, and Resolve or Reopen. A held
unsent pin offers Open, Move and Discard draft.

- **One op each, through the replica.** `lib/canvas/comments.ts` makes
  `thread.create`, `thread.message` (with `thread.update` to open a resolved
  thread again) and `thread.update`, and `commit` applies each with
  `source.apply()`: it is on the canvas at once, and `commit` answers once the
  API has it, or rejects with the API's words once it never will. The person
  is stamped from the session (`lib/canvas/actor.ts`); the API stamps it
  again. There is no "writing" signal to send: the cloud has none.
- **Drafts are on disk** (`lib/drafts.ts`, AsyncStorage `ponzu.drafts.<canvasId>`).
  Words stay in their draft until the API has them, not just until Send:
  sent words carry the id they were sent as (`sending`), so after the app was
  killed in between, the next open drops the draft if the API's canvas has
  that thread or message and keeps it, as an unsent pin, if not. Only the
  API's own doc settles drafts, never the cached copy. Signing out clears
  them with every other `ponzu.*` key.
- **Refused**, the words come back in the field with the API's reason under
  it (or, if something else is open by then, the pin stays unsent and the
  reason shows under the title). **Offline**, a comment is still applied and
  waits; the title says "Saved here. Ponzu sends it when you're back online."
  until it lands. Leaving the canvas or the app being killed before then
  loses the op but not the draft: leaving releases the canvas's sends
  (`drafts.release`), so the words show as an unsent pin on the next open
  unless the API's canvas has them. A reply's field opened again while its
  send is out shows only what was written after the sent words
  (`sentWords`), and the send landing takes only those words away
  (`landed`).
- **Read only.** On a canvas the person may only look at (no push access, or
  the last copy shown offline before the canvas opened), Comment is
  unavailable and VoiceOver says why ("You can look at this canvas. Steering
  it takes push access to <repo>."), a hold does nothing, and a thread's sheet
  shows that line in place of its reply field, with Resolve unavailable.
- **Proofs.** `bun test apps/mobile/lib/canvas/comments.test.ts` runs each op
  over the real `CloudSource` and the fake backend (shown at once, refused,
  read only, offline then landed, a reply reopening) and the drafts over a
  storage that outlives the app (killed before and after the API took it).
  `rntests/comments.rntest.tsx` renders the canvas screen against the fake
  with a stand-in web view: Comment, a tap, Send puts the op on the page at
  once; a refused one comes back with its words; a read-only canvas disables
  Comment. `canvas/page.webkit.test.ts` checks a tap after Comment drops a
  pin in WebKit. `maestro/comment.yaml` and `comment-modes.yaml` run the
  flows on a simulator, on spare only.

### The chat

Chat opens the canvas's one thread in a sheet near full height, over the
header's glass (iPhone design §9): a grabber, the thread and the composer,
nothing else. A link or push with `sheet=chat` opens it too, at
`message=<seq>` when it names one (older pages are read until that message is
held). Only Chat gives its field the keyboard. A swipe down, or VoiceOver's
escape, closes it, and closing marks the thread read as far as it held
(`seen` with `threadSeq`).

- **The thread** (`lib/chat/thread-store.ts`) is the `canvas.thread` live
  query beside the newest page of history, with older pages read as it is
  scrolled to the top while the live rows aren't there. It is the Mac's
  thread store on the phone's API object.
- **The lines** (`lib/chat/lines.ts`) are the Mac's rules from
  `@ponzu/client/model` (`shownItems`, `toThreadItem`, `threadRows`): a
  person's message is a bubble on the right, with the sender's avatar on its
  corner once more than one person has written; a comment is the picture of
  where it was left above its words, and pressing it closes the sheet and
  opens that pin's thread; Ponzu's reply is plain text drawn from Markdown;
  what Ponzu says on the way is quieter and in italics while the turn runs,
  then goes; there are no tool lines. An open question is not shown in the
  thread (it belongs in the composer's place, which the next slice builds).
- **The foot**, most pressing first: a billing blocker (its neutral first
  sentence and "This canvas waits.", never a way to pay), the owner's Claude
  (not connected, signed out, at its plan's limit), the sandbox (waiting for
  a machine, paused, failed), then the working line (the turning slice and
  what the agent is doing, "Waking up", or "Thinking" from the moment a
  message is sent).
- **Markdown** (`lib/prose.ts`, drawn by `lib/markdown.tsx`) is parsed by the
  Mac's parser and rules: micromark with GitHub's flavour and no footnotes,
  HTML as text, images as links named by their alt text, quotes three deep
  and emphasis four, and plain text for anything the Mac would refuse to
  parse. A link survives only to http, https or mailto. A link to a page or
  board of this canvas (`https://ponzu.design/canvases/<id>?page=…` or
  `?artboard=…`, read by `threadLink` in `lib/links.ts`) closes the sheet and
  goes there; one to another canvas opens it; any other opens in Safari's
  sheet (mail in Mail). The one difference from the Mac: React Native's URL
  is partial, so an address is matched whole by a pattern.
- **The composer** is the comment field (`components/composer.tsx`, typed or
  said) with Attach at its leading edge (pictures from the library, uploaded
  to the canvas and sent as the message's `attachments`) and, at its trailing
  edge, Send when there are words or Stop while a turn is live and the field
  is empty. A message mid-run goes straight in. A message shows at once as the
  person's bubble; one that doesn't go takes its bubble away and leaves its
  words in the field and its pictures over it, with "Couldn't send. Tap to try
  again." under it (tapping sends again). A billing refusal shows its first
  sentence and "This canvas waits." The unsent words are a draft on disk
  (`draftKey.chat`). On a canvas the person may only look at, or offline, the
  field is one quiet line instead.
- **Proofs.** `bun test apps/mobile/lib/prose.test.ts` (what a link may go
  to, images, HTML, depth limits, and the Mac's `parseable` and `settled`
  compared on the same texts), `lib/links.test.ts` (`threadLink`),
  `lib/chat` (the store over the fake backend; the lines and the foot).
  `rntests/chat.rntest.tsx` renders the canvas screen against the fake with
  the agent's turns played by the test: the lines, the aside going when the
  turn ends, Stop, a message mid-run, a picture, a send that fails and is
  sent again, a billing refusal, a board link and an outside link, the read
  only line, and closing marking the thread read. `maestro/chat.yaml` (seed
  `chat`) runs it on a simulator, on spare only.

### Needs you

While the agent waits on a person, what it asks takes the chat composer's
place (`components/needs-you.tsx`, iPhone design §10): one page at a time
under its own header, a yuzu dot before it and the pager `‹ n/m ›` after it
when more than one page waits. Each question of a multiple-choice ask is a
page; a plan, a permission, a secret or a hand-off is one. The rules for what
is answerable and what each answer says are the Mac's, from
`@ponzu/client/model` (`answer.ts`), and so are the card's words
(`lib/copy.ts` `NEEDS_YOU`, held to the Mac's source by `copy.test.ts`).

- **The kinds.** A question: its options on one track, the chosen raised with
  a tick (several on a multi-select, "Choose any."), and a note ("Add a note,
  or answer in words") that goes with them or is the answer. A plan: its first
  paragraph, "Read the plan" for the rest, Approve or Keep planning, and a
  note. A permission: its title, description and tool, Allow or Deny, and a
  note. A secret: a secure field whose value goes by its own route
  (`answerSecret`), never in the thread or an answer's body. A hand-off: Open
  its web address in Safari's sheet (only `http` and `https`), or Not now.
- **Sending.** Send answers the page in view and moves on; an ask goes once
  its last page is answered, and only once however often Send is pressed
  (`lib/chat/ask-store.ts`). Its live row then goes, and when none are left
  the composer is back.
- **Someone else first.** A question a teammate answers elsewhere leaves with
  its live row. If the person had started on it, or their answer comes back
  409 `question_closed`, it leaves and the next shows, with one line under the
  slot: "Sam already answered this.", or "Someone already answered this." when
  Ponzu can't say who, or "Claude moved on, so this needs no answer." for one
  the run withdrew.
- **An answer that doesn't go** keeps what was chosen and typed, with the
  Mac's reason under the slot. A billing refusal shows only its first
  sentence and "This canvas waits."
- **Read only or offline**, the card still shows what is asked, its options
  unpressable, and the read-only or offline line is in the field's place.
- **Links.** A push or link with `question=<id>` opens the chat at that
  question's page, and one naming another question while the card is up
  turns the pager to it.
- **Proofs.** `bun test apps/mobile/lib/chat/ask-store.test.ts` (order, sent
  once, a teammate's answer untouched and started, a 409 naming who answered,
  one naming nobody, a withdrawn question, an answer that doesn't go then
  does, a secret by its own route). `rntests/needs-you.rntest.tsx` renders the
  canvas screen against the fake: one question with no pager, four pages with
  the pager through a multi-select, a plan and a permission, a note alone as
  the answer, Send pressed twice, a teammate answering elsewhere, a 409, a
  push's question, a later push's question with the card up, a secret by its
  own route, and read-only. `rntests/canvas-stack.rntest.tsx` covers the
  count on Chat. `maestro/needs-you.yaml` (seed `needs-you`) runs it on a
  simulator, on spare only.

## Variants

Two apps build from this project (`app.config.ts`, by `APP_VARIANT`):

| | Production | Ponzu Dev (`APP_VARIANT=dev`) |
| --- | --- | --- |
| Name | Ponzu | Ponzu Dev |
| Bundle id | `design.ponzu.app` | `design.ponzu.app.dev` |
| Scheme | `ponzu://` | `ponzu-dev://` |
| API | `EXPO_PUBLIC_PONZU_API_URL`, which a production build must set | `https://api-dev.ponzu.design` unless set, WorkOS staging |
| Push tokens | production | development for the dev client, production for preview builds |
| Built by | `production.yml`, on a phone release | the development profile, and `preview.yml` by hand |

Neither takes universal links yet: `app.config.ts` sets no `associatedDomains`,
because `ponzu.design` serves no apple-app-site-association file and the
provisioning profile may lack the capability. Universal links on
`ponzu.design` return with the association file. Until
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
| `select` | A tab changing; a native menu opening; a page picked; typing ⇄ voice; settings opened from the lockup; a workspace picked; the Settled tray opened or closed; a canvas reopened; the project control or Attach pressed; a project, model or effort picked; a send stopped to ask first |
| `tick` | A canvas opened; Back; a board coming into focus or leaving it; a comment's pin dropped; New canvas opened; a new canvas sent |
| `success` | A comment or reply sent; a thread resolved; a new canvas made |
| `thud` | Sign out; a draft discarded; a canvas settled |
| `fail` | A sign-in that failed; a comment that didn't send; a settle or reopen that didn't take; a new canvas that couldn't be made |

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
with the team's certificates; then `APP_VARIANT=dev bunx expo start
--dev-client` from `apps/mobile`. Without `APP_VARIANT=dev` the dev server
serves the production variant, which names no API and stops at launch. Rebuild after any native change: a native dependency, a config
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
