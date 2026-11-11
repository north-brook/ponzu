# @ponzu/desktop

The Mac, Windows and Linux app: a window onto the studio (`apps/studio`), the session, links
and updates. There is no local server. The studio talks to Ponzu Cloud itself
([docs/cloud.md](../../docs/cloud.md), "Clients"), with an access token it borrows from the
main process.

```sh
bun run start                                   # build, then run against the built studio
PONZU_STUDIO_URL=http://localhost:5173 bun run start   # against the studio's Vite server
bun run package:dir                             # out/<platform>-unpacked, unsigned
PONZU_SMOKE=1 out/mac-arm64/Ponzu.app/Contents/MacOS/Ponzu   # must exit 0
```

A development build may also take `PONZU_API_URL` (https, or http on this computer) and
`PONZU_WORKOS_CLIENT_ID`. A packaged build ignores all three and talks to `api.ponzu.design`.
A development build is an app of its own, `Ponzu Local`: its own data folder
(`~/Library/Application Support/Ponzu Local`), keychain item ("Ponzu Local Safe Storage") and
single-instance lock, so it runs beside an installed Ponzu or Ponzu Dev and never touches their
sessions. It takes no links (on a Mac it runs inside node_modules' generic Electron.app, which
can't claim a scheme): use Ponzu Dev for those. GitHub's setup page then offers Ponzu's link
back; come back to the window instead.

## Ponzu Dev

```sh
bun run package:dev      # out/dev/mac-arm64/Ponzu Dev.app, and a zip of it beside
PONZU_SMOKE=1 "out/dev/mac-arm64/Ponzu Dev.app/Contents/MacOS/Ponzu Dev"
```

The cloud app for a Mac that still uses Ponzu 1.x, until the cloud release replaces it: the
release in everything (fuses, no debugging port, no session file, the CSP, sign-in,
`api.ponzu.design`) but who it is (`src/packaging.ts`, `src/config.ts`). It is "Ponzu Dev",
bundle id `design.ponzu.app.dev`, with its own icon (the release's on a grey tile, `bun run
icons:dev`), data folder (`~/Library/Application Support/Ponzu Dev`), keychain item ("Ponzu Dev
Safe Storage") and single-instance lock, and it takes `ponzu-dev://` links, declared in its
Info.plist so they reach it whether it is running or not. It never claims `ponzu://`, never runs the 1.x
cleanup and never writes into 1.x's folders. It doesn't update itself (there is no feed for it;
Check for Updates isn't in its menu): build a new one. It is ad-hoc signed and not notarized
unless built with the release's credentials. CI builds it and runs its smoke check on Linux.

It was called Ponzu Preview (`design.ponzu.app.preview`, `ponzu-preview://`), and a checkout run
was called Ponzu Dev. Its first launch (`src/carry-over.ts`) copies Ponzu Preview's window state
(the studio's localStorage: the workspace and design last open, the sidebar, rail and filters)
and keeps it through the signed-out launch until the person signs in; the designs Ponzu Preview
cached come over in the same copy and the studio drops them at once. While Ponzu Preview is
open, it asks the person to quit it and Try Again, or to Continue Without. The session can't come
with it: it is sealed by "Ponzu Preview Safe Storage", which only Ponzu Preview opens, so the
person signs in once. A "Ponzu Dev" folder a checkout run left is moved to "Ponzu Local" (or
beside it), and Ponzu Dev won't start while such a run is open.

On a Mac where a checkout ran before the rename, that run made a "Ponzu Dev Safe Storage"
keychain item, owned by node_modules' Electron.app. Delete it in Keychain Access before Ponzu
Dev's first launch (it only sealed that old checkout session, which Ponzu Local no longer reads),
and Ponzu Dev makes its own without asking; never answer Always Allow for it. Update every
checkout to the current `cloud` before its next `bun run start`: an older one still calls itself
Ponzu Dev and would open Ponzu Dev's folder. Nothing is deleted from code: Ponzu Preview's app
and folder stay for the person to remove. The API still links back to `ponzu-preview://` for a
Ponzu Preview that asks.

`PONZU_SESSION_FILE=<path>` runs on a developer session saved by `bun run dev:signin` in
apps/api instead of the keychain, rotating it in place, unencrypted (the window says so): for
driving the app without a browser. A development build takes it, and so does a test build,
which is the packaged app built with `PONZU_TEST_BUILD=1` (`scripts/build.ts`) and which also
allows `--remote-debugging-port` and developer tools. A release is never a test build: it
ignores the variable, quits when started with a debugging port, and has no developer tools.

```sh
PONZU_TEST_BUILD=1 bun run package:dir          # for spare or CI to drive, signed in
```

## Layout

```
src/
  main.ts           the process: the window, the session, links, menus, updates, lifecycle
  bridge.ts         window.ponzuDesktop and its channels: the studio's whole view of the shell
  preload.ts        exposes the bridge; nothing of Electron or Node reaches the page
  window.ts         the hardened main window and where it may go
  navigation.ts     what counts as the studio, and which links leave for the browser
  studio-files.ts   the studio's files, served from ponzu-studio://app
  csp.ts            the studio's content security policy
  session.ts        the one session: sign-in, tokens lent to the studio, errors it reports
  sign-in.ts        PKCE through WorkOS in the system browser, back to a loopback listener
  token-store.ts    tokens in a file only safeStorage can read, or in memory without a keychain
  session-file.ts   a developer's saved session, opt in
  deep-links.ts     ponzu:// links (ponzu-dev://)
  data-folder.ts    each app's data folder, and the smoke check's throwaway one
  packaging.ts      Ponzu Dev's electron-builder configuration, from the release's
  carry-over.ts     Ponzu Dev's first launch after it was Ponzu Preview
  updater.ts        electron-updater and the notes the update mark shows
  menu.ts           the menus
  legacy.ts         what Ponzu 1.x left on the computer, removed once
  linux.ts          an AppImage's desktop entry, so ponzu:// links reach it
  smoke.ts          PONZU_SMOKE
```

## The studio

Packaged, the studio is the files in `Resources/studio`, served from `ponzu-studio://app`: a
standard, secure scheme of our own, so its origin never changes (its storage stays put, the
API's CORS allows exactly it) and the app and its UI always match. Every file goes out with the
policy in `csp.ts`: script only from the studio itself, no frames, plugins or forms, and
nothing reached but the API, its environment's Neon Realtime host and assets host (exact
hosts, in `config.ts`; a development build allows any of each), and Google Fonts, for the
fonts a design names (the studio's own fonts ship inside it). Images load
from any https host, as the runner's previews draw them (docs/cloud.md, "Security").

A studio built for shipping carries no stand-in for Ponzu Cloud: with no bridge under it (a
preload that failed to load) it says Ponzu couldn't start, and the smoke check fails.

The window runs the studio as a web page and nothing more: context isolation, the renderer
sandbox, no Node, no webviews. It never leaves the studio: a navigation elsewhere is stopped,
and a link meant for the browser opens there only when it is plain https without credentials.
Every IPC handler answers only the studio, in the main window's top frame.

The packaged app's Electron fuses (`electronFuses` in package.json) turn off
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and load only the app's own asar,
checked against its signature. With those and no debugging port, another program on the
computer can't run code as Ponzu to read the session or the keychain item that trusts it.
Cookie encryption stays off: the app keeps no cookies (the API takes a bearer token), and
turning it on would have Chromium read the keychain at the first web request, even with nobody
signed in.

## Signing in

`session.ts` holds the only session (`createSession` from `@ponzu/client`). Continue with
GitHub starts `sign-in.ts`: a listener on `127.0.0.1`, a random port and `/auth/callback`
(registered with WorkOS for any port), PKCE, and the system browser. Only the redirect with this
sign-in's state is answered, with a page that says the tab can be closed; anything else that
reaches the listener gets a 404 and the wait goes on. The code and verifier then go to
`POST /v1/auth/exchange`.

Tokens are kept by `token-store.ts`, encrypted with `safeStorage` (the login keychain on a
Mac). Without a keychain (or with Linux's `basic_text`, a key in the clear), nothing is
written: the session lasts until Ponzu quits, and the window says so once signed in. The
keychain is asked only when there is a session to read or write, so a launch with nobody signed
in (and the smoke check) never prompts for it. The main process
is the only refresher, and the rotated pair is written before the new access token is used. The
studio borrows an access token per request and never sees the refresh token; Sign Out ends the
session at the API and forgets it here, with everything the studio kept: the designs last
opened (with the keys to their files) and the window's remembered state.

## Links

```
ponzu://design/<design id>?page=<page id>&artboard=<artboard id>   open a design
ponzu://github/setup?result=installed&workspace=<workspace id>     back from GitHub's install
ponzu://github/setup?result=requested | pending | sign_in | failed
```

They arrive on a cold start (`open-url` on the Mac, the command line elsewhere) and while
running (`second-instance`), and wait until the studio listens, which it does while someone
is signed in. Any web page can open one, so a
link only ever asks to show something: one that doesn't parse is dropped without a word. Ponzu
Dev takes `ponzu-dev://` instead, and leaves an installed Ponzu's links alone; a development
build takes none. The studio tells the API its scheme when it
asks for GitHub's install link, so the setup page links back to the app that asked.

## Updates

electron-updater checks GitHub Releases at launch and every four hours and downloads in the
background; the studio shows a yellow mark with the release notes and Restart
(docs/release-notes.md). When the API answers 426 the studio shows the update screen, which
looks for the update at once. The .deb installs only on Restart, never on quit, since dpkg asks
for a password.

## Ponzu 1.x

The first launch after the update removes what the local app wired up and the update left
dead (`legacy.ts`): the wake helper (a LaunchAgent, or systemd user units), the
`~/.ponzu/bin/ponzu` shim and the links to it on the PATH, and the `ponzu` MCP server in Claude
Code, Codex and Cursor that runs the shim. Each goes only when it is in the exact form 1.x
wrote and what it runs is gone; nothing goes while a 1.x app is still installed. Designs and
the rest of `~/.ponzu` are never touched, and neither is a Cursor `mcp.json` that is a link
(into someone's dotfiles, say). A step that fails is logged and doesn't stop the others. What
it did is in `legacy-cleanup.json` in the app's data folder, and it never runs again. Only the
release does any of this: Ponzu Dev and a development build run beside a 1.x still in use. Windows' PATH entry and design.json association are
removed by the uninstaller (`build/uninstall.ps1`).

## The smoke check

`PONZU_SMOKE=1` launches the window off screen and exits 0 once the studio has drawn its
sign-in screen and the bridge has answered over IPC that nobody is signed in; 1 if the studio
fails to load or comes up without the bridge. It never touches the keychain (the session is in
memory, so it starts signed out), the network (every request that would leave the computer
is refused and logged) or the app's data folder: it runs on a throwaway folder in the system's
temporary folder, removed once the process is gone (whether the check passed, failed, crashed or
was killed by its caller's timeout), so checking a packaged app on someone's Mac (where
`~/Library/Application Support/Ponzu` may be 1.x's) writes nothing of theirs. It claims no link
scheme either, so the copy in `out/` never becomes the one a person's links open. It looks for
no update.

A packaged app whose bundle and main process disagree on which app they are (a bundle named
"Ponzu Dev" holding a release's `dist/main.cjs`, say) refuses to start, before it reads any
data folder; `bun run package:dev` also checks its bundle's main process before it zips it.
