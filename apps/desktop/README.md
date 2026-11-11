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
`PONZU_SESSION_FILE=<path>` runs on a developer session saved by `bun run dev:signin` in
apps/api instead of the keychain, rotating it in place: for driving the app without a browser.

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
  deep-links.ts     ponzu:// links
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
nothing loaded or reached but the API, Neon Realtime, a design's files on `*.ponzu.cloud`, R2
for uploads, GitHub's avatars and Google Fonts.

The window runs the studio as a web page and nothing more: context isolation, the renderer
sandbox, no Node, no webviews. It never leaves the studio: a navigation elsewhere is stopped,
and a link meant for the browser opens there only when it is plain https without credentials.
Every IPC handler answers only the studio, in the main window's top frame.

## Signing in

`session.ts` holds the only session (`createSession` from `@ponzu/client`). Continue with
GitHub starts `sign-in.ts`: a listener on `127.0.0.1`, a random port and `/auth/callback`
(registered with WorkOS for any port), PKCE, and the system browser. Only the redirect with this
sign-in's state is answered, with a page that says the tab can be closed; anything else that
reaches the listener gets a 404 and the wait goes on. The code and verifier then go to
`POST /v1/auth/exchange`.

Tokens are kept by `token-store.ts`, encrypted with `safeStorage` (the login keychain on a
Mac). Without a keychain (or with Linux's `basic_text`, a key in the clear), nothing is
written: the session lasts until Ponzu quits, and the sign-in screen says so. The main process
is the only refresher, and the rotated pair is written before the new access token is used. The
studio borrows an access token per request and never sees the refresh token; Sign Out ends the
session at the API and forgets it here.

## Links

```
ponzu://design/<design id>?page=<page id>&artboard=<artboard id>   open a design
ponzu://github/setup?result=installed&workspace=<workspace id>     back from GitHub's install
ponzu://github/setup?result=requested | pending | sign_in | failed
```

They arrive on a cold start (`open-url` on the Mac, the command line elsewhere) and while
running (`second-instance`), and wait until the studio listens. Any web page can open one, so a
link only ever asks to show something: one that doesn't parse is dropped without a word. A
development build takes `ponzu-dev://` instead, through its checkout, and leaves an installed
Ponzu's links alone.

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
the rest of `~/.ponzu` are never touched. What it did is in `legacy-cleanup.json` in the app's
data folder, and it never runs again. Windows' PATH entry and design.json association are
removed by the uninstaller (`build/uninstall.ps1`).

## The smoke check

`PONZU_SMOKE=1` launches the window off screen and exits 0 once the studio has drawn its
sign-in screen, 1 if it fails to load. It never touches the keychain (the session is in
memory, so it starts signed out) or the network (every request that would leave the computer
is refused and logged), and looks for no update.
