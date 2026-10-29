# The canvas web view

The phone's canvas is a web page inside a `react-native-webview`. It draws a design exactly as
desktop does: each artboard in its own shadow root through `@ponzu/react`'s `ArtboardView`, with
the design's tokens and Google fonts, an agent's work developing in the same way, and the same
yuzu ring and rain round a board an agent is working on.
React Native owns everything else: the design's socket, the doc, and all the chrome. The page is a
renderer. The app posts it messages; it posts back gestures.

| File | What it is |
| --- | --- |
| `protocol.ts` | The messages, both ways. Types only; the app imports it. |
| `Canvas.tsx` | The canvas: boards, labels, pins, rings, the camera and the gestures. |
| `camera.ts` | Framing, focus, pins and momentum, as plain math. |
| `gestures.ts` | Touches turned into pan, pinch, tap, double-tap and hold. A double-tap focuses a board; pinching out or panning past it leaves. |
| `store.ts` | What the app has said; ops applied here with `applyOp` on echo. |
| `build.ts` | Builds `dist/index.html` and `dist/bundle.ts`. |
| `dev.html`, `dev.ts` | A harness that plays the app's part against a running Ponzu. |

## Build

```sh
bun apps/mobile/canvas/build.ts       # dist/index.html, dist/bundle.ts (gitignored)
bunx tsc -p apps/mobile/canvas/tsconfig.json --noEmit
bun test apps/mobile/canvas
```

`dist/bundle.ts` exports `canvasHtml`, one self-contained page (script, styles and Inter inlined,
about 400 KB). Metro should run the build before it bundles, as augmenter does for its editor:

```js
// metro.config.js
require("node:child_process").execFileSync("bun", [require("node:path").join(__dirname, "canvas/build.ts")], { stdio: "inherit" });
```

`fonts/` holds Inter 500 and 600 cut to Latin from `@expo-google-fonts/inter`:
`pyftsubset Inter_500Medium.ttf --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215" --layout-features="kern,liga,calt,tnum" --flavor=woff`.

## Using it from the app

```tsx
<WebView
  source={{ html: canvasHtml, baseUrl: `http://${mac}:7777/` }}
  applicationNameForUserAgent={`Ponzu-iOS/${version}`}
  scrollEnabled={false}
  bounces={false}
  originWhitelist={["*"]}
  onShouldStartLoadWithRequest={(r) => r.navigationType === "other" && r.url.startsWith(`http://${mac}:7777/`)}
  onMessage={(e) => handle(parseFromCanvas(e.nativeEvent.data))}
/>
```

Send messages with `ref.current.postMessage(JSON.stringify(msg))`, or `injectJavaScript(toCanvasScript(msg))`.
On `ready`, send `insets`, then `doc`; after that, every socket `op` (with its `origin`) and
`presence`. A `longpress` means: show the comment sheet, send `pending` with the pin and `insets`
with `sheet` set to the sheet's height; when the `thread.create` echo arrives, send `pending: null`.
`openThread` means: show the thread sheet and send `thread` with its id.
A comment sheet dismissed with words in it leaves its pin: send `unsent` with every such pin, by its
draft's key, and the threads with a reply left unsent. `openUnsent` means one was tapped: show its comment sheet again and send `pending`.
`focused` with a board means the board has the screen: hide the chrome. A pan or pinch on it sends
`gesture` as it begins (show the chrome), then `focused` again as it settles, with the board if it's
still focused (hide it again) or `null` if the fingers left it.

### Why `baseUrl` is the Mac

The page loads a design's images and fonts from `http://<mac>:7777/files/<key>/assets/…` itself.
A request a web page makes is refused there (`peerAllowed` → `isPage`) when it carries
`Sec-Fetch-Site`, or an `Origin` that isn't the phone's own. Measured against the branch's server
on a tailnet listener, from WebKit (Playwright's WebKit 27.2, the engine WKWebView uses):

| How the page is loaded | `<img>`, CSS `background`, `@font-face` | `mask-image`, `<img crossorigin>` |
| --- | --- | --- |
| `source={{ html }}` alone (an opaque origin) | 200: no Origin, no Sec-Fetch-* | 403: `Origin: null` |
| `baseUrl` = the Mac, UA with `Ponzu-iOS/` | 200 | 200: `Origin` is the Mac's own |

WebKit sends `Sec-Fetch-*` only to potentially trustworthy URLs (`updateRequestFetchMetadataHeaders`
in WebCore's `CachedResourceLoader.cpp` returns early otherwise), and a tailnet `http://` address
isn't one, so none of these requests carry it. With `baseUrl` set to the Mac, every load is
same-origin: CORS-mode loads send the Mac's own address as `Origin`, which `isPage` accepts from a
`Ponzu-iOS/` user agent, and need no CORS headers back. The page makes no other requests to the
Mac; the app holds the socket.
