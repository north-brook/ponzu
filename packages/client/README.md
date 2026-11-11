# @ponzu/client

What the Mac app, the iPhone app and a browser share to talk to Ponzu Cloud
([docs/cloud.md](../../docs/cloud.md)): the session, the typed API, live queries and the
canvas's source. It has no Node APIs and no DOM in its core, and runs as it is in Electron,
a browser and Hermes.

| Entry | For |
|---|---|
| `@ponzu/client` | `createSession`, sign-in, `createApi`, `createLive`, the row types and sorting |
| `@ponzu/client/react` | `LiveProvider`, `useLiveQuery`, `useSessionState` |
| `@ponzu/client/canvas` | `CloudSource`, wherever `@ponzu/canvas` runs (the studio, the phone's canvas web view) |
| `@ponzu/client/testing` | `createFakeBackend`, `FakeClock`, `FakeRealtime`: all of the above in memory |

## Signing in

```ts
const session = createSession({
  apiUrl: "https://api.ponzu.design",
  workosClientId,                       // public: the app ships it
  storage,                              // KeyValueStorage: get, set, delete of strings
  client: { platform: "macos", version: "2.0.0" },
});

const started = await startSignIn({ workosClientId, redirectUri });   // { url, state, codeVerifier }
// open started.url in the system browser; catch the redirect (loopback on the Mac,
// ponzu://auth/callback in an auth session on the phone)
const { code } = readRedirect(redirectUrl, started.state);
await session.completeSignIn({ code, codeVerifier: started.codeVerifier });
```

`session.getState()` is `loading`, `signed_out`, `signed_in` (with the user), `github_reauth`
(sign in again to re-grant GitHub) or `too_old` (the API answered 426: offer the update);
`session.subscribe` hears it change. The session refreshes the five-minute access token with
WorkOS shortly before it runs out (by the token's lifetime, so a device clock that is off does
not matter), one refresh at a time, and writes the rotated pair to `storage` before using it. A
refresh that WorkOS calls `invalid_grant` signs out, unless `storage` meanwhile holds a newer
pair.

Sessions may share one `storage` (two windows, browser tabs): each reads it before refreshing
and takes up a pair another has stored, so none spends a token another has already rotated.

`storage` holds the tokens: `safeStorage` in the Mac's main process, `expo-secure-store` on the
phone.

On the Mac the main process holds the session (`createSession` returns a `SessionHost`) and is
the only one that refreshes; the renderer never sees the refresh token. It borrows an access
token for each request over IPC:

```ts
const session = borrowSession({ apiUrl, client, lender });   // lender: SessionLender, over IPC
```

`lender.accessToken(rejected?)` is the host's `accessToken`, and `lender.report(error)` its
`take`, so an error the renderer hears (signed out elsewhere, too old) reaches the one session
that acts on it.

## The API

```ts
const api = createApi(session);
const { workspaces } = await api.me();
const design = await api.designs.create({ workspaceId, repoId });
```

One method per thing the apps ask (`api.ts`), typed from the API's own routes (`AppType`).
Each returns the answer's JSON or throws `ApiError`, whose `code` is the API's stable error
code (`not_found`, `forbidden`, `last_admin`, …) or `network` when nothing answered;
`error.transient` says whether trying again can help. An expired token is refreshed and the
request sent once more before you hear of it.

The thread's routes (`sendMessage`, `answer`, `stop`, `thread`, `upload`) are not on the API
yet: they are typed by hand in `thread-routes.ts` until they are.

## Live queries

```ts
const live = createLive({ api });
const off = live.subscribe("design.head", { designId }, ({ rows, status, error }) => …);
// in React, under <LiveProvider live={live}>:
const { rows, status } = useLiveQuery("workspace.designs", { workspaceId });
```

The names are the API's (`me`, `workspace.designs`, `design.head`, `design.thread`,
`design.questions`, `design.presence`); `LiveRows` types each one's rows. `status` is
`connecting` (no rows yet), `live`, `offline` (the last rows known, while reconnecting, paused
or failing) or `ended` (refused, for good: `error.code` says why). Rows come unordered: sort
with `byRecentActivity`, `bySeq` and `presentNow`.

Every subscription is renewed every 50 seconds, in one call (or one per 32, the API's limit). A
second `subscribe` to a query already answered hears its current snapshot straight away. Call `live.pause()` when the app
goes to the background and `live.resume()` when it comes back; each query then starts again
with a full fresh result. Neon Realtime is used only in `live/realtime.ts`.

## The canvas

```ts
const source = new CloudSource({ api, live, designId, me, cache: new DocCache(storage) });
<Canvas source={source} me={me} readOnly={!source.writable} />
source.onUnsaved(({ reason }) => toast("That change could not be saved."));
source.close();   // on leaving the design
```

`me` is the signed-in person as the API stamps their ops: `{ kind: "user", id, name, avatarUrl }`.
Edits show at once and are posted behind; undo and redo are the API's. `source.setPage(id)` tells
the others which page you are on, and `source.retryNow()` skips a wait when the network is back.
A design deleted or taken away while open turns the state to `error`, and whatever had not been
saved yet is reported through `onUnsaved`.
`DocCache` keeps the last designs opened, shown read only while the API cannot be reached; give
it storage meant for size (a file), not the keychain.

## On the phone

Hermes has less than a browser. The app provides, before this package runs:
`crypto.getRandomValues` (expo-crypto, for op ids), and passes `expo-crypto` to
`startSignIn({ crypto })` and `createApi(session, { crypto })` for SHA-256. React Native already
has `fetch`, `Headers`, `URLSearchParams`, `TextEncoder`, `queueMicrotask` and `WebSocket`.
`structuredClone`, which the replica uses, is the canvas web view's, not Hermes's.

## Testing

```ts
const backend = createFakeBackend();
const maya = backend.addPerson({ login: "maya" });
const ws = backend.addWorkspace({ login: "acme", members: { [maya.id]: "admin" }, repos: [{ name: "site" }] });
const { session, api, live } = backend.connect(maya);
backend.agent(designId).say("Drawing the hero");
```

`bun test packages/client` runs everything in memory. `src/cloud.live.test.ts` runs against the
real API and Neon Realtime when `PONZU_SESSION_FILE` (from `bun run dev:signin` in apps/api) and
`WORKOS_CLIENT_ID` are set.
