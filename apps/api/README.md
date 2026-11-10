# @ponzu/api

The HTTP API of Ponzu Cloud: one Hono app, served as one Vercel function on the Node runtime
in `iad1`, at `api.ponzu.design`. The architecture it implements is
[docs/cloud.md](../../docs/cloud.md).

```sh
bun test apps/api            # everything, in-process, no network
bun run dev                  # http://127.0.0.1:8787 against the Neon `dev` branch
bun run build                # dist/index.js, the bundle Vercel serves
```

## Layout

```
src/
  index.ts        the Vercel entry: reads the environment, default-exports the app
  create-app.ts   createApp(deps): middleware order, /v1, the 404/405 and error handlers; AppType
  env.ts          every environment variable, read and checked once (.env.example lists them)
  deps/           everything outside our code, behind interfaces, made in createDeps
    workos.ts       real: code exchange, email verification, session revoke, JWKS
    github.ts       real: as a person (user, emails, installations, repositories, token refresh)
                    and as the App (installation tokens)
    storage.ts      interface only, until the assets module
    realtime.ts     interface only, until the live-query module
  http/           errors, validation, request ids and logs, CORS, the client-version gate
  auth/           access declarations, access-token verification, sign-in
  vault/          sealing stored secrets
  github/         githubUserToken: a person's GitHub token, kept fresh
  routes/         one file per area, mounted under /v1 in routes/index.ts
  testing/        createTestApp and the fakes behind it
scripts/
  dev.ts          bun run dev
  dev-signin.ts   a real sign-in from a terminal, saved for end-to-end tests
  neon.ts         a Neon branch's connection string, by branch name
```

No file is named `app.ts` or `server.ts`, and nothing lives under `apps/api/api/`: Vercel's
Hono preset treats both as entry points.

## Adding a route

1. **Where.** A new area is `src/routes/<area>.ts` exporting a `new Hono<AppEnv>()` sub-app,
   plus one `.route("/<area>", <area>)` in `routes/index.ts`. Chain the calls (`.get(…).post(…)`):
   that is what carries the route's types to `AppType` and the typed client. Keep handlers
   thin; logic goes in a function beside the area (`auth/sign-in.ts` is the model) that takes
   the deps it uses as an argument.

2. **Who may call it.** The first handler of every route is an access declaration:

   ```ts
   .get("/", access.user, (c) => …)       // a signed-in person; c.var.actor.user
   .post("/x", access.runner, (c) => …)   // a sandbox's runner; c.var.actor.designId
   .get("/y", access.public, (c) => …)    // anyone
   ```

   or the whole area declares once with `.use(access.user)` before its routes. A route that
   declares nothing, or declares after something else has run, answers 403
   `access_undeclared`, and a test fails. `access.user` proves who is asking, not what they may
   touch: check that against the database in the handler. A runner may act only on
   `c.var.actor.designId`.

3. **Validation.** Requests: `validate("json" | "query" | "param", schema)` after the access
   declaration, then `c.req.valid(…)`. Responses: define the body as a zod schema and send
   `c.json(Schema.parse(value))`. The schema is the allowlist, so a row passed whole cannot
   leak a column. JSON is camelCase; `/v1/auth/exchange` keeps OAuth's three snake_case names.

4. **Dependencies.** Read them from `c.var.deps` (`db`, `clock`, `vault`, `workos`, `github`,
   `sandbox`, `storage`, `realtime`, `log`, `config`). Never import a client, the database or
   the clock as a module-level value, never call `fetch` or `Date.now()` directly, and never
   read `process.env` outside `env.ts`. The API writes no SQL: add a query function to
   `@ponzu/db`. Something new to talk to is an interface in `deps/`, a real implementation
   that takes `fetch` and `clock`, a line in `createDeps`, and a fake in `testing/`.

5. **Errors.** Throw `new ApiError(status, code, message, { details?, cause? })`. Every error
   leaves as `{ "error": { "code", "message", "details"? } }`. `code` is from the `ErrorCode`
   list in `http/errors.ts`; clients branch on it, so add a code there rather than reuse one,
   and never rename one. `message` is shown to people. Anything else thrown becomes 500
   `internal` with nothing of the failure in the body; the failure is in the log. A failed call
   to another service is an `UpstreamError` and becomes 502 `upstream_unavailable`. No sub-app
   sets its own `onError`.

6. **Logs.** `c.var.log.info(event, fields)`: ids and outcomes, never a body, a header or a
   query string. Every line is redacted on the way out (`http/log.ts`) as a backstop; a field
   whose name contains `token`, `secret` or `key` loses its value, so name fields honestly.

7. **Tests.** Beside the route, through the app:

   ```ts
   const t = await createTestApp();
   const maya = await t.signInAs({ login: "maya" });
   const response = await t.app.request("/v1/me", { headers: maya.headers });
   ```

   `createTestApp` is the real app on an in-process Postgres with `t.workos` and `t.github`
   (in-memory services behind the real clients), `t.sandbox` (`FakeProvider`), `t.storage`,
   `t.realtime`, `t.clock` (moves only when told), `t.logs` and `t.db`. `signInAs` goes through
   the real exchange; `startSignIn` stops before it. Give GitHub installations and
   repositories with `t.github.installations.push(…)`. Nothing in it can reach the network.

## What clients send

| Header | |
|---|---|
| `Authorization: Bearer <WorkOS access token>` | Every route but health and the exchange. `token_expired` means refresh with WorkOS and retry; `token_invalid`, `user_not_found` and `github_reauth_required` mean sign in again. |
| `X-Ponzu-Client: <platform>/<version>` | `macos/2.0.0`, `ios/1.4.2`. When the API answers 426 `client_too_old`, offer the update; `details.minimumVersion` says what is enough. Off unless `PONZU_MIN_CLIENT_VERSIONS` is set. |
| `X-Request-Id` | Optional, 8 to 64 of `A-Za-z0-9_-`. Every answer carries one; quote it when something fails. |

CORS allows the desktop studio's origin (`ponzu-studio://app`), `https://ponzu.design` and its
subdomains, and `http://localhost` / `http://127.0.0.1` on any port. Auth is a bearer token,
never a cookie, so this is about where Ponzu's UI runs, not about protecting data
(`http/cors.ts`).

## Stored secrets

`deps.vault.seal(value, { column, row })` before writing an `encrypted_…` column,
`deps.vault.open(…)` with the same binding after reading one. The binding is authenticated, so
a value copied to another row or column does not open. To rotate the key: set
`PONZU_VAULT_KEY` to a new one and move the old one into `PONZU_VAULT_OLD_KEYS`; drop it from
there once everything it sealed has been sealed again (GitHub tokens are, at each refresh or
sign-in).

For a person's GitHub token call `githubUserToken(deps, userId)` each time one is needed. It
refreshes when the token is within five minutes of running out, one refresh at a time per
person across all instances, and it throws `github_reauth_required` when only signing in again
will do.

## Local development

`bun run dev` needs the variables in [.env.example](.env.example), from the shell or
`apps/api/.env.local`. With `NEON_API_KEY` and `NEON_PROJECT_ID` set it finds `DATABASE_URL`
itself, always for the branch named `dev`; with `GITHUB_APP_PRIVATE_KEY_PATH` it reads the key
from that file.

`bun run dev:signin` signs a real person in through the browser against any API base URL and
saves the session to `PONZU_SESSION_FILE` (see the top of `scripts/dev-signin.ts`).

A schema change is applied to the `dev` branch by hand, before the code that needs it is
deployed:

```sh
cd packages/db && DATABASE_URL="$(bun ../../apps/api/scripts/neon.ts dev --direct)" bun run db:migrate
```

## Deploying

Until the repository is connected to the Vercel project, a deploy is from the command line, at
the repository root, with a current CLI (`VERCEL_ORG_ID` is the team id, `VERCEL_PROJECT_ID`
the `ponzu-api` project's):

```sh
bunx vercel@latest deploy --prod --yes
```

The project's Root Directory is `apps/api`; [vercel.json](vercel.json) does the rest.

**Why the build is ours.** Vercel's default Hono builder transpiles file by file and leaves
import specifiers alone, which cannot run this repo's style (workspace packages that export
TypeScript source, `.ts` specifiers): it deploys green and every request fails. Of the three
builds that do work we use the one with nothing experimental in it: `bun build` bundles
`src/index.ts` and the workspace packages into `dist/index.js`, with `hono` left external so
the preset still recognises the entry. The costs: the Vercel build does not typecheck (CI
does, and `scripts/ci/api-bundle.ts` loads the bundle in Node), and a `maxDuration` in
`vercel.json` is not applied to a bundled entry, so the function has the platform default of
300 seconds. If a route ever needs longer, switch to `VERCEL_EXPERIMENTAL_BACKENDS=1`, which
honours it.

The environment variables live on the Vercel project, for Production and Preview, as
sensitive values. `GITHUB_APP_PRIVATE_KEY` is the PEM as it is, many lines. Until cutover
`DATABASE_URL` is the pooled URL of the Neon `dev` branch in both.
