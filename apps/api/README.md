# @ponzu/api

The HTTP API of Ponzu Cloud: one Hono app, served as one Vercel function on the Node runtime
in `iad1`, at `api.ponzu.design`. The architecture it implements is
[docs/cloud.md](../../docs/cloud.md).

```sh
bun test apps/api            # everything, in-process, no network
bun run dev                  # http://127.0.0.1:8787 against the Neon `dev` branch
bun run build                # dist/index.js, the bundle Vercel serves
bun run typecheck            # src/ against Node's types: what the runtime really has
```

## Layout

```
src/
  index.ts        the Vercel entry: reads the environment, default-exports the app
  create-app.ts   createApp(deps): middleware order, /v1, the 404/405 and error handlers
  types.ts        AppType, for the typed client (`@ponzu/api/types`): types only
  env.ts          every environment variable, read and checked once (.env.example lists them)
  deps/           everything outside our code, behind interfaces, made in createDeps
    workos.ts       real: code exchange, email verification, session revoke, user delete, JWKS
    github.ts       real: as a person (user, emails, installations, repositories, org role, token
                    refresh) and as the App (installation lookups and tokens, repo lists, a
                    person's permission in a repo)
    background.ts   work that outlives its request
    storage.ts      real: Cloudflare R2 over its S3 API (presigned PUTs, head, copy, delete)
    sigv4.ts        AWS Signature Version 4 on Web Crypto, for storage
    poke.ts         real: `POST /poke` to an awake runner through its sandbox's address
    realtime.ts     real: seals live queries with the branch's Realtime secret
    model.ts        real: a Claude model on Ponzu's own Anthropic key, structured answers
  http/           errors, validation, request ids and logs, CORS, the client-version gate
  auth/           access declarations, authentication, authorization, sign-in
  vault/          sealing stored secrets
  github/         githubUserToken: a person's GitHub token, kept fresh; syncGithub and
                  reconcileInstallation: workspaces, members and repos in line with GitHub;
                  the install round trip and its setup page; what each webhook does
  designs/        committing ops, undo, the current document and its cache, who may send
                  which op (op-rules.ts), and the events a design's feed gets
  runner/         the runner protocol's side here: its request bodies (protocol.ts), the
                  session, thread writes, git credentials; runner.e2e.test.ts runs the real
                  runner against these routes
  uploads/        what may be uploaded and how it is served (files.ts), presign and complete
  sandboxes/      wake.ts: requestWake, the one door from what people do to a design's sandbox
  live/           queries.ts: every live query, its arguments, who may watch it and its SQL
  jobs/           runJob and runDueJobs: work recorded in `jobs`, run now and retried by the cron
  ideas/          a repo's ideas: the light read (read-repo.ts, snapshot.ts), the prompt and
                  its checks (prompt.ts), when they are made and kept (ideas.ts)
  routes/         one file per area, mounted under /v1 in routes/index.ts
  testing/        createTestApp and the fakes behind it; designs.ts for workspaces to test in
scripts/
  dev.ts          bun run dev
  dev-signin.ts   a real sign-in from a terminal, saved for end-to-end tests
  neon.ts         a Neon branch's connection string and Realtime, by branch name
  github-webhook.ts  the App's webhook: where it points, its secret, redelivering failures
  ideas.ts        a real repo's ideas, made as the API makes them, with what they cost
```

No file is named `app.ts` or `server.ts`, and nothing lives under `apps/api/api/`: Vercel's
Hono preset treats both as entry points.

The code runs on Node and is tested on Bun. `src/` outside the tests may use only what Node
has: no `Bun.…`, no DOM. `bun run typecheck` (and CI) checks exactly that.

## Adding a route

1. **Where.** A new area is `src/routes/<area>.ts` exporting a `new Hono<AppEnv>()` sub-app,
   plus one `.route("/<area>", <area>)` in `routes/index.ts`. Chain the calls (`.get(…).post(…)`):
   that is what carries the route's types to `AppType` and the typed client. Keep handlers
   thin; logic goes in a function beside the area (`auth/sign-in.ts` is the model) that takes
   the deps it uses as an argument.

2. **Who may call it.** The first handler of every route is an access declaration:

   ```ts
   .get("/", access.user, (c) => …)           // a signed-in person; c.var.actor.user
   .post("/x", access.runner, (c) => …)       // a sandbox's runner; c.var.actor.designId
   .post("/z", access.userOrRunner, (c) => …) // either; tell them apart by c.var.actor.kind
   .get("/y", access.public, (c) => …)        // anyone
   ```

   A runner holds its design's lease (docs/cloud.md, "The runner protocol"): `access.runner` and
   `access.userOrRunner` take a runner only with the design's current `X-Ponzu-Runner`, and
   answer 409 `superseded` to anything else, so no route checks it again. The one route that
   takes the lease, `POST /v1/runner/session`, declares `access.runnerStarting` instead.

   An area whose routes are all for people (or all for runners) may declare once, with
   `.use(access.user)` before them. **`access.public` is always written on the route itself**:
   on an area with `.use` it opens nothing. A route no declaration covers answers 403
   `access_undeclared` before its handler runs, and a test fails.

   A declaration says who is asking, not what they may touch. For that, `auth/authorize.ts`:
   `await requireWorkspace(c, workspaceId)` returns the workspace as the person sees it, or
   throws 404 `not_found` when they are not a member (the same as when it does not exist), and
   `requireWorkspace(c, id, "admin")` throws 403 `forbidden` for a member who is not an admin.
   `await requireDesign(c, designId, "read" | "write")` does the same for a design, with
   membership of its workspace and the access GitHub gives the person in its repo, and lets a
   runner at its own design only. Get a row another person could not see only through a
   function there, and add the next one beside them with the same two answers.

   **Repo access has one home**, `repo_access`, and one module, `auth/repo-access.ts`. Ask it
   with `repoPermission` (a fresh answer, or GitHub asked as the App, with the ten-minute
   fallback); a person's sync and `refreshWorkspaceRepoAccess` write a whole workspace's
   answers at once with `recordReposReachedBy`; a list of repos or designs (or a live query
   over one) joins the table, after `refreshWorkspaceRepoAccess` where it must be current.
   A webhook that cannot say whose access changed calls `markRepoAccessStale`. Never keep a
   second copy of who can reach what.

   To turn a token into a person anywhere else (a socket, a sealed query), call
   `authenticateUser(deps, token)` from `auth/authenticate.ts`. It verifies the WorkOS token
   and requires a session `/v1/auth/exchange` admitted (the `sessions` table). There is no
   other way: WorkOS hands a well-signed token to anyone who signs in with it directly, so a
   token's `sub` on its own names nobody Ponzu let in.

3. **Validation.** Requests: `validate("json" | "query" | "param", schema)` after the access
   declaration, then `c.req.valid(…)`. Responses: define the body as a zod schema and send
   `c.json(Schema.parse(value))`. The schema is the allowlist, so a row passed whole cannot
   leak a column. JSON is camelCase; `/v1/auth/exchange` keeps OAuth's three snake_case names.
   Two routes are not JSON, both GitHub's to call: `GET /v1/github/setup` is a page a browser
   lands on (`github/setup-page.ts`: no script, everything escaped, its own strict headers), and
   `POST /v1/github/webhook` reads its raw body to check the signature before parsing it.

4. **Dependencies.** Read them from `c.var.deps` (`db`, `clock`, `vault`, `workos`, `github`,
   `sandbox`, `storage`, `poke`, `realtime`, `model`, `docs`, `gitTokens`, `background`, `log`,
   `config`). Never import a client,
   the database or the clock as a module-level value, never call `fetch` or `Date.now()`
   directly, and never read `process.env` outside `env.ts`. Something new to talk to is an
   interface in `deps/`, a real implementation that takes `fetch` and `clock`, a line in
   `createDeps`, and a fake in `testing/`.

   **The database.** The API writes no SQL: add a query function to `@ponzu/db`, one
   statement each. `deps.db` is Neon over HTTP, which has no transactions; `db.transaction`
   throws, under `createTestApp` too. (The first module that truly needs one adds a
   `createPooledDb` handle to `Deps` in `createDeps`, not in a route.) A statement has ten
   seconds to answer, then fails as 503 `database_unavailable`.

   **Work after the answer.** `c.var.deps.background("wake", promise)` is the only way to
   leave a promise running past a response: it keeps the instance alive for it and logs a
   failure. Await everything else: on a rejection nobody handles, Vercel ends the instance,
   with the other requests it is serving, and the app cannot stop it. The linter flags a
   floating promise where it can tell there is one. Work that must happen even if the
   instance dies or the work fails is a job: record it in `jobs` held by the request, run it
   with `runJob` in the background, and add its kind to `HANDLERS` in `jobs/run.ts`; the
   cron (`GET /v1/cron/minute`, every minute on production) runs it again after a failure,
   or once the request's lock runs out. The GitHub webhook is the model.

5. **Errors.** Throw `new ApiError(status, code, message, { details?, cause? })`. Every error
   leaves as `{ "error": { "code", "message", "details"? } }`. `code` is from the `ErrorCode`
   list in `http/errors.ts`; clients branch on it, so add a code there rather than reuse one,
   and never rename one. `message` is shown to people. Anything else thrown becomes 500
   `internal` with nothing of the failure in the body; the failure is in the log. A failed call
   to another service is an `UpstreamError` and becomes 502 `upstream_unavailable`; where the
   service's answer means something (GitHub's 404 or 403 for a repository), catch it, read
   `error.status`, and throw the `ApiError` that says so. A refusal thrown by Hono's own
   middleware (`bodyLimit`, a rate limiter) keeps its status and gets our code. No sub-app sets
   its own `onError`.

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
   (in-memory services behind the real clients), `t.sandbox` (`FakeProvider`), `t.storage`
   (`MemoryStorage`, which holds a presigned PUT to what R2 does: its `fetch` serves the
   signed addresses and refuses other bytes, headers, sizes or a late PUT), `t.poke` (the
   pokes, recorded), `t.realtime`, `t.model` (`FakeModel`: every request it was sent, answered
   from `reply(…)`), `t.clock`, `t.logs` and `t.db`. `signInAs` goes through the real exchange;
   `startSignIn` stops before it. Give GitHub installations and repositories with
   `t.github.installations.push(…)`. `await t.backgroundDone()` waits for what routes handed
   to `deps.background`. Nothing in it can reach the network.

   `t.clock` moves only when told, and it is the API's clock: token expiry, the GitHub token
   refresh, presence, repo access answers, timeouts and waits follow it. What `@ponzu/db` times
   with Postgres's own `now()` does not: runner token expiry and job leases.
   (When a job is due is the API's clock: `runJob` and the cron set and compare it by
   `deps.clock`.) A query
   function that needs the time takes `now` from its caller (as the GitHub token claim does);
   convert one of the others when your module comes to depend on its timing.

   For designs, `testing/designs.ts` makes a workspace whose repository each named person can
   reach as given (`workspaceWithRepo(t, { maya: "write", ines: "read" })`), designs in it,
   and their runners: `startRunner(t, designId)` takes a token and the lease through the real
   session route (`runner.headers` carry both), and `designWithRunner` makes a design with one.
   `feedOf(db, designId)` from `@ponzu/db/testing` is a design's whole feed, for asserting the
   events something added.

   `deps/storage.live.test.ts` runs uploads against the real bucket, through the routes: it is
   skipped unless `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and
   `PONZU_ASSETS_URL` (the bucket's public URL) are set.

## Live queries

`POST /v1/live` seals the queries in `live/queries.ts` and no others. Neon Realtime has no
row-level security, so a query's SQL is its access control: its `authorize` throws the same
404 or 403 the matching route would, and answers the values the SQL binds, which is constant
text. Realtime delivers a change as a small delta only for plain filters and joins, so no
`ORDER BY`, `LIMIT`, aggregate, subquery or `now()`; it sends a row whole on every change,
so never a design's content, an `encrypted_…` column or an asset key. A test holds every query
to that.

`live/realtime.live.test.ts` runs the real thing against the `dev` branch: it seals a query,
subscribes, commits an op through the API and waits for the change. It is skipped unless
`DATABASE_URL`, `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` are set.

## What clients send

| Header | |
|---|---|
| `Authorization: Bearer <WorkOS access token>` | Every route but health and the exchange. `token_expired` means refresh with WorkOS and retry; `token_invalid`, `session_unknown` and `github_reauth_required` mean sign in again. |
| `X-Ponzu-Client: <platform>/<version>` | `macos/2.0.0`, `ios/1.4.2`. When the API answers 426 `client_too_old`, offer the update; `details.minimumVersion` says what is enough. Off unless `PONZU_MIN_CLIENT_VERSIONS` is set. |
| `X-Request-Id` | Optional, 8 to 64 of `A-Za-z0-9_-`. Every answer carries one; quote it when something fails. |

A client imports `AppType` from `@ponzu/api/types` and nothing else from this package.

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
from that file. This is how to run a branch: the apps and `dev-signin` take its address.

`bun run dev:signin` signs a real person in through the browser against any API base URL and
saves the session to `PONZU_SESSION_FILE` (see the top of `scripts/dev-signin.ts`).

## Deploying

**`api.ponzu.design` is the head of `cloud`, and merging is how it gets there.** On every
push to `cloud`, [deploy-api.yml](../../.github/workflows/deploy-api.yml) applies the pending
migrations to the Neon `dev` branch, deploys to production, and checks that `/v1/health`
answers with the commit. Nobody runs `vercel deploy --prod` from a checkout: the API the apps
are built against would become whichever branch deployed last. And nobody applies a migration
by hand: it reaches the shared database when it merges, so write it to work with the code
that is already deployed.

The workflow runs once the repository variable `API_DEPLOY` is `true`. It reads the variables
`VERCEL_TEAM_ID`, `VERCEL_API_PROJECT_ID` and `NEON_PROJECT_ID`, and the secrets `VERCEL_TOKEN`
(one that can deploy to the `ponzu-api` project) and `NEON_API_KEY`. Until then, whoever
merges into `cloud` runs the workflow's two commands by hand, from the merged head.

To see a branch built and running on Vercel, deploy a preview, at the repository root
(`VERCEL_ORG_ID` is the team id, `VERCEL_PROJECT_ID` the `ponzu-api` project's):

```sh
bunx vercel@latest deploy --yes --env VERCEL_GIT_COMMIT_SHA="$(git rev-parse HEAD)"
```

A preview runs against the same `dev` database with the same secrets, so it does not get a
migration its branch adds; for that, `bun test` and CI's Postgres job are the check.

**Every deployment holds the live secrets**, so only production's own domains are public. The
project has Vercel Authentication on (Standard Protection): a preview, and the unique URL of
every production deployment, old ones included, opens only for someone signed in to the team.
Keep it on. Vercel deletes a superseded deployment after 30 days (the project's retention
policy); after a fix for something exploitable, delete the deployments that came before it
at once (`bunx vercel@latest remove <deployment url>`). Before cutover, Preview gets its own
database, secrets and vault key.

The project's Root Directory is `apps/api`; [vercel.json](vercel.json) does the rest, and
`engines.node` in `package.json` is the Node version Vercel serves on and CI loads the bundle
in. The `--env` is how `/v1/health` knows its commit: Vercel sets that variable itself only for
a deployment made from a connected repository, and this one is deliberately not connected.

**Why the build is ours.** Vercel's default Hono builder transpiles file by file and leaves
import specifiers alone, which cannot run this repo's style (workspace packages that export
TypeScript source, `.ts` specifiers): it deploys green and every request fails. Of the three
builds that do work we use the one with nothing experimental in it: `bun build` bundles
`src/index.ts` and the workspace packages into `dist/index.js`, with `hono` left external so
the preset still recognises the entry. The costs: the Vercel build does not typecheck (CI
does, and `scripts/ci/api-bundle.ts` loads the bundle in Node), and a `maxDuration` in
`vercel.json` is not applied to a bundled entry, so the function has the platform default of
300 seconds. Nothing waits that long: every call out (WorkOS, GitHub, the database) has ten
seconds. If a route ever needs longer than the default, switch to
`VERCEL_EXPERIMENTAL_BACKENDS=1`, which honours `maxDuration`.

The environment variables live on the Vercel project, for Production and Preview, as
sensitive values. `GITHUB_APP_PRIVATE_KEY` is the PEM as it is, many lines. Until cutover
`DATABASE_URL` is the pooled URL of the Neon `dev` branch in both. At cutover, turn off
scale-to-zero on the production database's endpoint: a waking database eats into those ten
seconds.

`GITHUB_WEBHOOK_SECRET` is the secret the App's webhook is signed with, so it changes in two
places at once: set the new value on the project, then point the App at it with
`bun scripts/github-webhook.ts configure` (which also sets the URL). Deliveries in between fail
their signature check; once the deploy is live, `bun scripts/github-webhook.ts redeliver` sends
them again. GitHub never retries a failed delivery by itself. One the API answered 202 is a job
by then, and the cron retries its work.

`CRON_SECRET` is what Vercel sends as the bearer of each cron request (`crons` in
[vercel.json](vercel.json)); Vercel reads that exact name from the project. Crons run on
production only, so a preview never runs its jobs again by itself.
