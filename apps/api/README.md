# @ponzu/api

The HTTP API of Ponzu Cloud: one Hono app, served as one Vercel function on the Node runtime
in `iad1`, at `api-dev.ponzu.design` for dev and `api.ponzu.design` for production. The
architecture it implements is
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
    github-octokit.ts  how all of it reaches GitHub: Octokit on our fetch and clock, the App's
                    JWT and installation tokens (auth-app), pages, GraphQL, and GitHub's
                    failures as the API's errors. No retry or throttling plugin, on purpose
    github-pull-requests.ts  a canvas's pull request: the one GraphQL read and describing
                    it as the App, opening and acting on it as the person
    background.ts   work that outlives its request
    storage.ts      real: Cloudflare R2 over its S3 API (presigned PUTs and GETs, head, copy,
                    delete, list, delete many), signed with SigV4 by aws4fetch; `archives` is
                    the same, on R2_PRIVATE_BUCKET when it is set
    poke.ts         real: `POST /poke` to an awake runner on its sandbox's public port, with
                    the port's bearer token; a 502 or 503 just after a start is tried again
    anthropic.ts    real: whether Anthropic takes an API key, a person's or Ponzu's own (the
                    free list of models)
    realtime.ts     real: seals live queries with the branch's Realtime secret
    model.ts        real: Claude Haiku (ideas) and Sonnet (their gate) via the AI SDK on Ponzu's own key, structured answers
  http/           errors, validation, request ids and logs, CORS, the client-version gate
  auth/           access declarations, authentication, authorization, sign-in
  vault/          sealing stored secrets
  github/         githubUserToken: a person's GitHub token, kept fresh; syncGithub and
                  reconcileInstallation: workspaces, members and repos in line with GitHub;
                  the install round trip and its setup page; what each webhook does;
                  people.ts: everyone GitHub gives access, read once per installation
  canvases/        committing ops, undo, the current document and its cache, who may send
                  which op (op-rules.ts), and the events a canvas's feed gets
  runner/         the runner protocol's side here: its request bodies (protocol.ts), the
                  session, thread writes, git credentials, checkpoints (checkpoint.ts: the
                  transcript and work-in-progress archives, kept where no client reads them,
                  restoring them, and rebuilds and rollbacks logged); runner.e2e.test.ts runs the
                  real runner against these routes
  pull-requests/  a canvas's pull request: sync.ts reads it and records it (the one place a
                  merge settles a canvas), refresh.ts reads it again after webhooks, as jobs,
                  open.ts opens it and keeps the agent's summary and picture in it, actions.ts
                  is what a person does to it, view.ts is what the tab is sent;
                  pull-requests.live.test.ts runs it against the real test repository
  uploads/        what may be uploaded and how it is served (files.ts), presign and complete
  sandboxes/      wake.ts: requestWake, the one door from what people do to a canvas's sandbox;
                  orchestrate.ts: the wake job, one path for a create, a resume and a restart
                  in place (`up()`, `ponzu-stop` if it was running, `ponzu-start`);
                  stop.ts: putToSleep (`ponzu-stop`, then Vercel's stop, then the pending
                  rule); retire.ts: a settled or deleted canvas's sandbox, holding its row
                  until the delete; environment.ts: what a runner starts with; sweep.ts: the
                  minute's look (retire, stop, restart, lapse, sleep, cycle, extend, repair)
                  and the tenth minute's reconcile; constants.ts: the session's numbers
  claude/         a person's own Claude: connecting a key or a subscription (sign-in.ts drives
                  `claude setup-token` in a utility sandbox), disconnecting, and the models
  environments/   a repo's secrets (what a name may be, how a value is sealed) and its base's
                  rebuild, recorded as a job whose handler only marks it for now
  billing/        a billing period (period.ts), the credit arithmetic and its rounding
                  (credits.ts), and Plan and usage worked out from usage events (usage.ts)
  account/        deleting a person's account, step by step
  live/           queries.ts: every live query, its arguments, who may watch it and its SQL
  jobs/           runJob and runDueJobs: work recorded in `jobs`, run now and retried by the cron
  ops/            selfcheck.ts: the deployment's checks of its own dependencies and settings
                  (`/v1/cron/selfcheck`, and hourly from the cron); github-app.ts: the
                  permissions and events the API needs of its GitHub App
  ideas/          a repo's ideas: the light read (read-repo.ts, snapshot.ts), the prompt and
                  its checks (prompt.ts), when they are made and kept (ideas.ts)
  routes/         one file per area, mounted under /v1 in routes/index.ts
  testing/        createTestApp and the fakes behind it; canvases.ts for workspaces to test in
scripts/
  dev.ts          bun run dev
  dev-signin.ts   a real sign-in from a terminal, saved for end-to-end tests
  neon.ts         a Neon branch's connection string and Realtime, by branch name
  github-webhook.ts  the App's webhook: where it points, its secret, redelivering failures
  ideas.ts        a real repo's ideas, made as the API makes them, with what they cost
  images.ts       which image each canvas's sandbox runs, and what its next wake does about it
  build.ts        bun run build: the runner bundle, then the API with it inlined
```

No file is named `app.ts` or `server.ts`, and nothing lives under `apps/api/api/`: Vercel's
Hono preset treats both as entry points.

The code runs on Node and is tested on Bun. `src/` outside the tests may use only what Node
has: no `Bun.…`, no DOM. `bun run typecheck` (and CI) checks exactly that.

**Sandboxes.** Canvases' sandboxes are Vercel Sandboxes in the ponzu-api project, named
`pz-<scope>-<canvasId>` (the scope is the database's, `SandboxConfig.scope`, so deployments
sharing the project keep apart). On Vercel the API reaches them with its functions' OIDC token,
which exists only inside a request: `@ponzu/sandbox` is called from a handler, or from work a
handler handed to `deps.background` (the cron is a request too), never at module load or from a
stray timer. Off Vercel, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` together.

The image is not a variable: `apps/runner/image/current.json` names it by digest, and the build
inlines it, so an image ships with the API deploy. A canvas on another image is recreated on
this one at its next wake, unless its last checkpoint is behind its session
(`bun scripts/images.ts` shows where a rollout stands). The runner itself is not in the image:
`bun run build` builds it, inlines it, and `GET /v1/runner/bundle` serves it to `ponzu-start`,
which names the hash it wants (`PONZU_RUNNER_BUNDLE`) at every start.

## Adding a route

1. **Where.** A new area is `src/routes/<area>.ts` exporting a `new Hono<AppEnv>()` sub-app,
   plus one `.route("/<area>", <area>)` in `routes/index.ts`. Chain the calls (`.get(…).post(…)`):
   that is what carries the route's types to `AppType` and the typed client. Keep handlers
   thin; logic goes in a function beside the area (`auth/sign-in.ts` is the model) that takes
   the deps it uses as an argument.

2. **Who may call it.** The first handler of every route is an access declaration:

   ```ts
   .get("/", access.user, (c) => …)           // a signed-in person; c.var.actor.user
   .post("/x", access.runner, (c) => …)       // a sandbox's runner; c.var.actor.canvasId
   .post("/z", access.userOrRunner, (c) => …) // either; tell them apart by c.var.actor.kind
   .get("/y", access.public, (c) => …)        // anyone
   ```

   A runner holds its canvas's lease (docs/cloud.md, "The runner protocol"): `access.runner` and
   `access.userOrRunner` take a runner only with the canvas's current `X-Ponzu-Runner`, and
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
   `await requireCanvas(c, canvasId, "read" | "write")` does the same for a canvas, with
   membership of its workspace and the access GitHub gives the person in its repo, and lets a
   runner at its own canvas only. Get a row another person could not see only through a
   function there, and add the next one beside them with the same two answers.

   **Repo access has one home**, `repo_access`, and one module, `auth/repo-access.ts`. Ask it
   with `repoPermission` (a fresh answer, or GitHub asked as the App, with the ten-minute
   fallback); a person's sync and `refreshWorkspaceRepoAccess` write a whole workspace's
   answers at once with `recordReposReachedBy`; a list of repos or canvases (or a live query
   over one) joins the table, after `refreshWorkspaceRepoAccess` where it must be current.
   A webhook that cannot say whose access changed calls `markRepoAccessStale`. Never keep a
   second copy of who can reach what. A `read` in the table is one GitHub GAVE the person;
   the read anyone has of a public repo never reaches it (the App's `read` is settled by the
   person's own list), so a route that reads the table needs no rule of its own for public
   repos. `auth/public-repo-read.test.ts` runs every canvas route as a stranger and fails for
   a new route under `/v1/canvases/:id` until it is added there. The one exception is for show:
   `workspace_people.repo_permissions` (`github/people.ts`) is the App's snapshot of who
   GitHub lists in each repo, kept so the team can be shown before people open Ponzu. It is
   never consulted to grant anything, and for anyone with a `repo_access` answer that answer
   wins (`listRepoPeople`).

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
   lands on (`github/setup-page.ts`, a handoff from `@ponzu/core/handoff`: one fixed script and
   one fixed style sheet allowed by their hashes, everything else escaped, its own strict
   headers), and
   `POST /v1/github/webhook` reads its raw body to check the signature before parsing it.

4. **Dependencies.** Read them from `c.var.deps` (`db`, `clock`, `vault`, `workos`, `github`,
   `sandboxes`, `runnerBundle`, `storage`, `poke`, `realtime`, `model`, `docs`, `gitTokens`,
   `background`, `log`, `push`, `config`). Never import a client,
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
   cron (`GET /v1/cron/minute`, every minute on dev and production) runs it again after a failure,
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
   (in-memory services behind the real clients), `t.sandboxes` (`FakeSandboxes`, which models
   Vercel as the live suite recorded it: sessions, snapshots, the commands each session ran),
   `t.anthropic` (the API keys Anthropic takes), `t.storage`
   (`MemoryStorage`, which holds a presigned PUT to what R2 does: its `fetch` serves the
   signed addresses and refuses other bytes, headers, sizes or a late PUT, and serves a signed
   GET), `t.poke` (the pokes, recorded with the port token each carried),
   `t.realtime`, `t.model` (`FakeModel`: every request it was sent, answered
   from `reply(…)`), `t.push` (`FakePush`: every ping sent, answered with scripted tickets,
   failures and receipts; `createTestApp({ push: false })` runs with push off), `t.clock`,
   `t.logs` and `t.db`. `signInAs` goes through the real exchange;
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

   For canvases, `testing/canvases.ts` makes a workspace whose repository each named person can
   reach as given (`workspaceWithRepo(t, { maya: "write", ines: "read" })`), canvases in it,
   and their runners: `startRunner(t, canvasId)` takes a token and the lease through the real
   session route (`runner.headers` carry both), and `canvasWithRunner` makes a canvas with one.
   `feedOf(db, canvasId)` from `@ponzu/db/testing` is a canvas's whole feed, for asserting the
   events something added.

   Branches and pull requests are `t.github.pulls` (`testing/fake-pull-requests.ts`), for the
   repository `t.github.repo(fullName)` names: `push` a commit, `openAsSomeone`, `setChecks`,
   `review`, `comment`, `protect` the base (with who may bypass it), `lagHead` and `hideMerges`
   to act out GitHub's reads running behind, and `pull(…)` to read or change one. It answers the
   GraphQL operations the API sends by their names, keeps `mergeable` unknown for
   `MERGEABLE_AFTER_MS` after a change, as GitHub does, refuses a merge in GitHub's words, and
   records what was done and by whom (`actions`).

   `deps/storage.live.test.ts` runs uploads against the real bucket, through the routes: it is
   skipped unless `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and
   `PONZU_ASSETS_URL` (the bucket's public URL) are set. `pull-requests/pull-requests.live.test.ts`
   opens, reads and merges a pull request in the real test repository; the top of the file says
   what it needs. `deps/push.live.test.ts` sends one ping to a real phone through Expo and reads
   its receipt: it is skipped unless `PONZU_LIVE_PUSH=1`, `EXPO_ACCESS_TOKEN` and
   `PONZU_LIVE_PUSH_TOKEN` (that phone's Expo push token) are set.

   Push (`deps/push.ts`) is the one seam that cannot take our `fetch`: Expo's server SDK calls
   the global one. Its tests stub the global `fetch` for the length of each test, and
   `push.surface.test.ts` holds that nothing else imports the SDK.

## Live queries

`POST /v1/live` seals the queries in `live/queries.ts` and no others. Neon Realtime has no
row-level security, so a query's SQL is its access control: its `authorize` throws the same
404 or 403 the matching route would, and answers the values the SQL binds, which is constant
text. Realtime delivers a change as a small delta only for plain filters and joins, so no
`ORDER BY`, `LIMIT`, aggregate, subquery or `now()`; it sends a row whole on every change,
so never a canvas's content, an `encrypted_…` column or an asset key. A test holds every query
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
| `X-POSTHOG-SESSION-ID` | Optional: posthog-js's `tracing_headers` sends it. What the request captures goes under that session ([docs/analytics.md](../../docs/analytics.md)). `X-POSTHOG-DISTINCT-ID` is allowed and ignored: who a request is about is who it authenticated as. |

A client imports `AppType` from `@ponzu/api/types` and nothing else from this package.

CORS allows the desktop studio's origin (`ponzu-studio://app`), `https://ponzu.design` and its
subdomains, and `http://localhost` / `http://127.0.0.1` on any port. Auth is a bearer token,
never a cookie, so this is about where Ponzu's UI runs, not about protecting data
(`http/cors.ts`).

## Stored secrets

`deps.vault.seal(value, { column, row })` before writing an `encrypted_…` column,
`deps.vault.open(…)` with the same binding after reading one. The binding is authenticated, so
a value copied to another row or column does not open. A new sealed column goes into
`SEALED_COLUMNS` in `packages/db/src/queries/sealed.ts` with its binding; a test fails while an
`encrypted_` column is missing from it.

To rotate the key: set `PONZU_VAULT_KEY` to a new one and move the old one into
`PONZU_VAULT_OLD_KEYS`, and deploy. Once that deployment serves every request, run
`bun scripts/reseal.ts` here with the deployment's `DATABASE_URL`, `PONZU_VAULT_KEY` and
`PONZU_VAULT_OLD_KEYS` (`--dry-run` first writes nothing). It opens every value an old key
sealed and seals it again under the new one, one row at a time and only if the row still holds
what it read, so it can be stopped and run again. A GitHub token whose refresh is in flight is
left for the next run, because the refresh stores its new pair only over the sealed text it
read. It prints counts per column and key id, the rows it could not seal again (ids and secret
names, never a value), and how many values are still under another key, and exits 1 while that
is more than 0 or any value would not open. When it reports nothing left, drop the old key and deploy. Running it before the
deployment with the new key is live would seal values the API cannot open yet.

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

The API is one Vercel project, `ponzu-api`, with two environments
([docs/production.md](../../docs/production.md)):

- **Dev** is the project's custom environment `dev`, at `https://api-dev.ponzu.design`. It is
  the head of `main`, and merging is how it gets there.
- **Production** is the project's Production target, at `https://api.ponzu.design`. It serves
  the released apps (Mac 2.0.0, iPhone 1.0.0) and is deployed only from `main`.
- **Preview** is for throwaway builds of a branch.

On a push to `main`, [deploy-api.yml](../../.github/workflows/deploy-api.yml) runs the whole
staged procedure, one run at a time, and deploys nothing when the merge changed nothing the API
is made from (`scripts/ci/api-paths.ts`). Its `dev` job applies the pending migrations to the
Neon `dev` branch, deploys with `vercel deploy --environment dev`, and checks that
`https://api-dev.ponzu.design/v1/health` answers `dev` with the commit, its image and every
migration applied, that the selfcheck passes, and (once its secrets exist) that a real turn
works as the check account. Only after that, its `production` job records the deployment
serving `api.ponzu.design`, snapshots and migrates the Neon default branch, deploys with
`--prod --skip-domain`, checks the new deployment, promotes it, checks `api.ponzu.design` and
that the minute's schedule is active, and promotes the recorded deployment back if a check after
the promotion fails. A failed deploy opens an issue labelled `deploy-failed`
(docs/production.md, "The production deploy, staged").
Nobody deploys a branch or a checkout with `--prod`: the API the apps are built against would
become whichever branch deployed last. And nobody applies a migration by hand: it reaches the
shared database when it merges, so write it to work with the code that is already deployed.

The workflow is off until the repository variable `API_DEPLOY` is `true`, and production also
needs `API_DEPLOY_PRODUCTION`. Neither is set today, so a push deploys nothing, and the
orchestrator runs the steps by hand from `main`'s merged head. For dev: the migration
(`bun apps/api/scripts/neon.ts dev --direct` into `db:migrate`, as the job does), then, at the
repository root (`VERCEL_ORG_ID` is the team id, `VERCEL_PROJECT_ID` the `ponzu-api`
project's):

```sh
bunx vercel@65.14.0 deploy --environment dev --yes --env VERCEL_GIT_COMMIT_SHA="$(git rev-parse HEAD)"
bun scripts/ci/health.ts --env dev --commit "$(git rev-parse HEAD)"
```

A dev deploy is never `--prod` and never `--environment production`. Production by hand is the
orchestrator's alone, from `main`, after dev has taken the same commit: the production job's
snapshot and migration of the default branch, then `deploy --prod`, then
`bun scripts/ci/health.ts --env production --commit <sha>`.

**`vercel promote`, `vercel rollback` and `vercel alias set` belong to the production runbook
alone.** Promoting a deployment that is not a production build makes a new production
deployment from it, with production's variables, and gives it `api.ponzu.design`
([vercel promote](https://vercel.com/docs/cli/promote)), so promoting a dev deployment would put
dev's build on production. Dev is taken back by deploying the older commit again with
`--environment dev`: check it out, and run the commands above.

To see a branch built and running on Vercel, deploy a preview, at the repository root:

```sh
bunx vercel@65.14.0 deploy --yes --env VERCEL_GIT_COMMIT_SHA="$(git rev-parse HEAD)" \
  --env PONZU_ENVIRONMENT=preview --env PONZU_API_URL=https://api-dev.ponzu.design
```

On Vercel, `PONZU_ENVIRONMENT` and `PONZU_API_URL` are required: a deployment without either
stops at boot naming it (`EnvError`), rather than letting its runners call production's
address. It also stops when `PONZU_ENVIRONMENT` disagrees with the Vercel environment it runs in,
which Vercel sets as `VERCEL_TARGET_ENV`: `production` belongs on the Production target only,
`preview` on Preview, and `dev` on the `dev` environment, so dev's values deployed with `--prod`
or production's on dev never start. An unset `VERCEL_TARGET_ENV` is logged and allowed, in
every environment, until a deployment's log has shown that Vercel sets it (production serves
people, so the guard does not bet its uptime on the docs). Every boot logs one
`environment_pair` line with both names and whether they agree. The `dev` environment sets the two variables (`dev` and
`https://api-dev.ponzu.design`); a preview takes them from the Preview target, or from the
command above. A preview whose `PONZU_ENVIRONMENT` says `dev` (or anything but `preview`)
never starts, so pass `--env PONZU_ENVIRONMENT=preview` as above. A preview shares dev's
database, so its runners call dev's address. `/v1/health` answers which environment a
deployment is, its commit, the runner image and bundle it ships, and whether the database's
applied migrations equal the journal it was built with (`degraded` at 200 when they do not).

A preview runs against the same `dev` database with the same secrets, so it does not get a
migration its branch adds; for that, `bun test` and CI's Postgres job are the check.

**Which secrets each environment holds.** The project's variables are set per environment, as
sensitive values:

- The `dev` environment holds dev's: the Neon `dev` branch, WorkOS staging, the `ponzu-dev`
  App, dev's vault key and cron secret, and the rest of dev's list, plus its own
  `PONZU_ENVIRONMENT=dev` and `PONZU_API_URL=https://api-dev.ponzu.design`.
- The Preview target holds dev's values too, since a preview is dev's database and secrets.
- The Production target holds production's own values and nobody else's (docs/production.md,
  "Env and secrets").

On GitHub, the environment `dev` (only `main` may use it) is to hold dev's `VERCEL_TOKEN`, dev's
`CRON_SECRET` and the canary's `CANARY_SESSION_WRITER`, and
the environment `production` (only `main`, no reviewer) holds
`VERCEL_TOKEN_PRODUCTION`, `VERCEL_AUTOMATION_BYPASS_SECRET` and `NEON_API_KEY`. Both jobs
read the variables `VERCEL_TEAM_ID`, `VERCEL_API_PROJECT_ID` and `NEON_PROJECT_ID`; dev's
migration reads the repository's `NEON_API_KEY`. Both GitHub environments exist; what each still
lacks is in docs/production.md, "Turning on the deploy workflow".

**Every deployment holds live secrets**, so only the two API domains are public. The project
keeps Vercel Authentication on its deployments (the legacy Standard Protection,
`prod_deployment_urls_and_all_previews`): a preview, a dev deployment's own URL, and the unique
URL of every production deployment, old ones included, open only for someone signed in to the
team. That setting protects a custom environment's domain too, so `api-dev.ponzu.design` is
public through a Deployment Protection Exception for that one domain, and the project's setting
is unchanged. Keep both. Vercel deletes a superseded deployment after 30 days (the project's
retention policy); after a fix for something exploitable, delete the deployments that came
before it at once (`bunx vercel@65.14.0 remove <deployment url>`).

The project's Root Directory is `apps/api`; [vercel.json](vercel.json) does the rest, and
`engines.node` in `package.json` is the Node version Vercel serves on and CI loads the bundle
in. The `--env` is how `/v1/health` knows its commit: Vercel sets that variable itself only for
a deployment made from a connected repository, and this one is deliberately not connected.

**Why the build is ours.** Vercel's default Hono builder transpiles file by file and leaves
import specifiers alone, which cannot run this repo's style (workspace packages that export
TypeScript source, `.ts` specifiers): it deploys green and every request fails. Of the three
builds that do work we use the one with nothing experimental in it: `scripts/build.ts` builds
the runner bundle, then `Bun.build` bundles `src/index.ts` and the workspace packages into
`dist/index.js` with that bundle inlined (`define`, through Bun's API since it is about a
megabyte), and `hono` left external so the preset still recognises the entry. The costs: the Vercel build does not typecheck (CI
does, and `scripts/ci/api-bundle.ts` loads the bundle in Node), and a `maxDuration` in
`vercel.json` is not applied to a bundled entry, so the function has the platform default of
300 seconds. Every call out (WorkOS, GitHub, the database) has ten seconds. The longest waits
are a stop's (`ponzu-stop` has 30 seconds, then Vercel's stop and snapshot, a few seconds) and
a wake's (up to 30 seconds waiting out a stop under way, `up()`, a stop of what was running,
the start); a wake that has to wait longer leaves the rest to the job's next attempt. If a route ever needs
longer than the default, switch to
`VERCEL_EXPERIMENTAL_BACKENDS=1`, which honours `maxDuration`.

The environment variables live on the Vercel project, per environment, as sensitive values.
`GITHUB_APP_PRIVATE_KEY` is the PEM as it is, many lines. `DATABASE_URL` is the pooled URL of
the Neon `dev` branch in `dev` and Preview, and the default branch's on the Production target. No
entry may cover the Production target and another environment (docs/production.md, "Env and
secrets"). Scale-to-zero is to be off on the production database's endpoint (`infra/neon.json`;
`scripts/prod/check.ts` reads it): a waking database eats into those ten seconds.

`GITHUB_WEBHOOK_SECRET` is the secret the App's webhook is signed with, so it changes in two
places at once: set the new value in that environment, then point the App at it with
`bun scripts/github-webhook.ts configure --env dev` (or `--env production`; it also sets the
URL, from that environment's `apiUrl` in `infra/environments.json`). Deliveries in between fail
their signature check; once the deploy is live, `bun scripts/github-webhook.ts redeliver` sends
them again. GitHub never retries a failed delivery by itself. One the API answered 202 is a job
by then, and the cron retries its work.

`CRON_SECRET` is what Vercel sends as the bearer of each run of the minute's schedule; Vercel
reads that exact name from the deployment that is current in the environment, so dev's schedule
sends dev's value and production's sends production's, and a new value is sent only once a
deploy makes it current ([Handling scheduled runs](https://vercel.com/docs/schedules/handle-runs)).

**Schedules.** The minute is a Vercel Schedule, `minute` in [vercel.json](vercel.json): a GET
on `/v1/cron/minute` every minute, with Vercel's one-minute jitter. `vercel.json` also still
carries the legacy `crons` entry, which Vercel runs only on the Production target: it is how
production's minute ran before the schedule, and it stays until the schedule has been seen
firing in production, so production never goes a minute without a run. While both are on,
production runs the route twice a minute, which the steps allow; the project's **Disable Cron
Jobs** switch then turns the cron off without a deploy, and turning it back on is the way back
(docs/production.md, "The minute"). Once the cron is off, turn it back on before any rollback of
production to a deployment from before the schedule: that rollback deletes the schedule, and the
switch keeps the cron off, so nothing would run the minute. Dev never ran the legacy cron. Vercel keeps a separate copy
of a static schedule for production and for each custom environment. Production's starts
active on its first deploy. In the `dev` environment a new schedule starts inactive, and once enabled it stays
as it was set across later deploys ([Managing Schedules](https://vercel.com/docs/schedules/manage)),
so it is enabled once, by hand. Every `vercel schedules` command reads production unless told
otherwise, so always spell out `--environment dev`:

```sh
bunx vercel@65.14.0 schedules list --environment dev                     # minute: active or inactive
bunx vercel@65.14.0 schedules enable minute --environment dev            # once, after dev's first deploy
bunx vercel@65.14.0 schedules invoke minute --environment dev            # one run now, whatever its state
bunx vercel@65.14.0 schedules executions list minute --environment dev   # what each run answered
```

A preview never runs the minute. A Preview branch's schedule copy starts inactive (Vercel does
not document the starting state of the copy kept for a person's own CLI deployments, so do not
count on it), and the route itself answers
`{ steps: {} }` and logs `cron_skipped` on `PONZU_ENVIRONMENT=preview`, since a preview shares
dev's database and dev's minute already does that work. Each run records when it ran (one row
in `jobs`, `cron/heartbeat.ts`); `/v1/health` reports it as `cron.lastRanAt`, and the
selfcheck's `cron_fresh` fails when it is five minutes old (`stale`) or missing (`never_ran`).
The run's time is the scheduler's `ce-vssscheduledat` when that is within two minutes of the
clock, so a run that starts late in its minute still does that minute's steps.

**After a deploy, ask the selfcheck.** `GET /v1/cron/selfcheck` takes the same bearer and
answers every check of the deployment's dependencies and settings, each `ok` or not with a
fixed word saying why ([src/ops/selfcheck.ts](src/ops/selfcheck.ts)). Read the secret into
the shell without printing it, then:

```sh
curl -s -H "authorization: Bearer $CRON_SECRET" https://api-dev.ponzu.design/v1/cron/selfcheck
```

The minute's cron runs the same checks at minute 7 of every hour and raises each failure to
PostHog error tracking as `selfcheck_failed`. A `github_app` failure names, in `missing`, the
permissions or events from [src/ops/github-app.ts](src/ops/github-app.ts) the App lacks;
`vault_old_keys` counts values still sealed under a key in `PONZU_VAULT_OLD_KEYS`.
