# The canvas web view

The phone's canvas is a web page inside a `react-native-webview`. It draws a canvas exactly as
the Mac does: each artboard in its own shadow root through `@ponzu/canvas`'s `ArtboardView`, with
the canvas's tokens and Google fonts, and an agent's work developing in the same way. A board the
agent is working on gets the yuzu ring and nothing else, on a pure white or pure black ground
(the founder's 11 Nov direction).
React Native owns everything else: the session, the API, the canvas's replica (`CloudSource`,
on the React Native side) and all the chrome. The page is a renderer. It holds no token and calls
no API. The app posts it messages; it posts back gestures.

| File | What it is |
| --- | --- |
| `protocol.ts` | The messages, both ways, and the asset-origin placeholder. Types and constants; the app imports it. |
| `Canvas.tsx` | The canvas: boards, labels, pins, rings, the camera and the gestures. |
| `camera.ts` | Framing, focus, pins and momentum, as plain math. |
| `gestures.ts` | Touches turned into pan, pinch, tap, double-tap and hold. A double-tap focuses a board; pinching out or panning past it leaves. |
| `store.ts` | What the app has said; each op applied here with `applyOp` on a fresh copy of the doc. |
| `probe.ts` | The canvas timing its own gestures, when the app asks: frames and camera moves, as `perf/` counts them. |
| `picture.ts` | A comment's picture, when the app asks: drawn with the Mac's code (packages/canvas's `comment-picture.tsx`), light and dark, as PNG (WebKit can't write WebP), sent back as base64. |
| `csp.ts` | The page's content security policy. |
| `build.ts` | Builds `dist/index.html` and `dist/bundle.ts`. |
| `page.webkit.test.ts` | The built page in Playwright's WebKit, loaded as the app loads it. |
| `dev.html`, `dev.ts` | A harness that plays the app's part against a running Ponzu 1.x (not updated for the cloud). |

## Build

```sh
bun apps/mobile/canvas/build.ts       # dist/index.html, dist/bundle.ts (gitignored)
bunx tsc -p apps/mobile/canvas/tsconfig.json --noEmit
bun test apps/mobile/canvas           # page.webkit.test.ts needs `bunx playwright-core install webkit`, else skips
```

`dist/bundle.ts` exports `canvasHtml`, one self-contained page (script, styles and Inter inlined,
about 500 KB). Metro runs the build before it bundles (metro.config.js).

Text draws at the size the canvas gives it, as on the Mac: iOS would otherwise autosize small
text in any block wider than the screen (every board is), so `canvas.css` and the boards' own
base styles (`ARTBOARD_BASE_CSS`) pin `-webkit-text-size-adjust: 100%`. Playwright's WebKit
doesn't autosize; check it in the simulator.

`fonts/` holds Inter 500 and 600 cut to Latin from `@expo-google-fonts/inter`:
`pyftsubset Inter_500Medium.ttf --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215" --layout-features="kern,liga,calt,tnum" --flavor=woff`.

## Where the page loads from, and its policy

The page loads with its base URL at the canvas's `assetsUrl`
(`https://assets.ponzu.cloud/<key>/`), so every image, font and mask a board loads is
same-origin and R2 needs no CORS (iPhone design D3). `build.ts` writes a content security policy
into the page's `<head>`, modelled on the Mac's (apps/desktop/src/csp.ts):

```
default-src 'none'; script-src 'sha256-<the page's script>'; style-src 'unsafe-inline' https://fonts.googleapis.com;
font-src data: <assets> https://fonts.gstatic.com; img-src data: blob: https: <assets>; media-src blob: <assets>;
connect-src <assets> https://fonts.googleapis.com https://fonts.gstatic.com; object-src 'none'; frame-src 'none';
base-uri 'none'; form-action 'none'
```

The page is built once with `__ASSETS__` where the policy names the asset origin; the app puts
the canvas's origin in its place (`lib/canvas/page.ts`, which takes only an https origin with a
plain host) before it loads the page. The build refuses a script that contains the placeholder,
since the app's replacement would then change what the hash pins. The app's own messages arrive
through WKWebView's `evaluateJavaScript` and react-native-webview's message handler, which a
page's policy does not govern. The web view goes nowhere but its first load: every navigation
reaches `onShouldStartLoadWithRequest`, which allows only the base URL and `about:blank`
(`originWhitelist` stays `["*"]`, because react-native-webview opens anything it doesn't allow
with `Linking.openURL`).

## Using it from the app

`components/canvas-view.tsx` loads it; `lib/canvas/bridge.ts` speaks for the replica. On `ready`
the app sends `insets`, `theme`, then `doc` (with `assetBase` and `file`, the canvas id),
`presence` and `working` (the boards the agent works on, from the canvas's head), then
`pending`, `unsent` and `thread`. After that each op CloudSource hears goes as `op`, with its
`origin`, and the whole doc goes again whenever an op can't say what changed: a refused op rolled
back, a resync, the cached copy, or someone else's op landing under one of the person's own
before the API has answered it. A remount (iOS ends the page's process in the background) loads
the page again, which says `ready` and gets everything.

A `longpress` means: show the comment sheet, send `pending` with the pin and `insets` with
`sheet` set to the sheet's height; once the comment is in, send `pending: null`.
`openThread` means: show the thread sheet and send `thread` with its id.
A comment sheet dismissed with words in it leaves its pin: send `unsent` with every such pin, by its
draft's key, and the threads with a reply left unsent. `openUnsent` means one was tapped: show its comment sheet again and send `pending`.
`picture` (with an `id`, a thread and a message) asks for the picture of where the person's
comment was left: the page waits for the comment to reach its doc (up to 5 seconds), draws it
off screen in both themes, and answers `picture` with the same `id` and each theme's PNG as
base64, `none` when there is nothing round the pin to show, or `failed`
(lib/canvas/pictures.ts uploads them). The drawing reads default styles in a frame it writes
itself, so `about:srcdoc` is allowed beside the base URL and `about:blank`. Its scene takes the
Mac's ground and pin colours from `.pz-root` in `canvas.css`, so everyone's thread shows the same
picture.
`probe` with a rate has the page measure that share of gestures (`probe.ts`), each sent back as
`perf` when the camera comes to rest; see `perf/README.md`.
`focused` with a board means the board has the screen: hide the chrome. A pan or pinch on it sends
`gesture` as it begins (show the chrome), then `focused` again as it settles, with the board if it's
still focused (hide it again) or `null` if the fingers left it.
