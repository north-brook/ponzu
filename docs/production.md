# Production

How Ponzu Cloud runs in production: every resource and what is right for it, the order in
which the founder creates them, how each secret is rotated, how the data is backed up and
restored, and what bounds the bill. The specification is [cloud.md](cloud.md); this page is the
runbook behind its "Environments" section.

**What exists today, and what does not.** The desired state in [`infra/`](../infra) and its
reader, [`scripts/prod/desired.ts`](../scripts/prod/desired.ts), are built and tested, as are
the scripts that check and apply that state (`scripts/prod/check.ts`, `apply.ts`,
`restore-drill.ts`) and create the GitHub App (`github-app.ts`), the API's
`/v1/cron/selfcheck`, its `PONZU_ENVIRONMENT` variable and boot guard, the environment, image,
bundle and migration counts in `/v1/health`, the `dev` environment at `api-dev.ponzu.design`,
and the deploy jobs in [`deploy-api.yml`](../.github/workflows/deploy-api.yml), each off until
its own variable is set (neither is today). The scripts are tested against fakes and answers
recorded from dev; `apply.ts` has never sent a write to a vendor, and `github-app.ts` has never
created an App. The check and apply scripts were written for two Vercel projects: they read the
project's name from `environments.json` (now `ponzu-api` for both environments) but look only at
its Production target, so they do not yet check dev's custom environment the way "Checking
production" below describes. That part is marked *(not built yet)*.

**Production is live.** It went live on 12 Nov 2026: `api.ponzu.design` is the Production
target of `ponzu-api`, on the Neon default branch, and serves the released apps (Mac 2.0.0 and
iPhone 1.0.0, which cannot be recalled, so every API change must keep working for them). The
orchestrator deploys it by hand from `main` until `API_DEPLOY_PRODUCTION` is set ("Turning on
the deploy workflow"). Its minute still runs on the legacy cron while the schedule takes over
("The minute").

## One project, two environments

| | Dev | Production |
|---|---|---|
| Vercel | `ponzu-api`, its custom environment `dev` | `ponzu-api`, its Production target |
| API | `api-dev.ponzu.design` | `api.ponzu.design` |
| Database | Neon branch `dev` | the Neon project's default branch |
| Auth | WorkOS staging | WorkOS production |
| GitHub App | `ponzu-dev` | `ponzu` |
| Files | `assets-dev.ponzu.cloud` | `assets.ponzu.cloud` (bucket `ponzu-assets`), plus `ponzu-private` for checkpoints |
| Analytics | PostHog "Ponzu Dev" (728454) | PostHog "Ponzu" (731171) |
| The minute | dev's copy of the `minute` schedule, turned on once by hand | the legacy cron, then production's copy of the schedule ("The minute") |
| Deploys | from `main`, with `vercel deploy --environment dev`, by the deploy workflow's `dev` job or the orchestrator | from `main` only: by the orchestrator by hand today; staged and promoted by the `production` job, which the founder approves, once it is turned on |
| Vercel token | dev's `VERCEL_TOKEN`, in the GitHub Environment `dev` (the repository's until that exists) | `VERCEL_TOKEN_PRODUCTION`, in the GitHub Environment `production` |

The project's third environment, **Preview**, is for throwaway builds of a branch: behind Vercel
Authentication, on dev's database with dev's values, with `PONZU_ENVIRONMENT=preview`, and it
never runs the minute.

**Why one project.** Production once needed a project of its own because Vercel ran crons only
on a project's Production target, and the sandbox sweep and the job retries run on the minute.
Vercel's Schedules removed that reason: "Vercel keeps a separate set of schedules for
production, each custom environment, each Preview branch, and CLI deployments by each user"
([Schedules concepts](https://vercel.com/docs/schedules/concepts)), so dev's minute runs in its
own environment ("The minute", below). A custom environment gives dev its own variables, its own
domain and its own name: Vercel sets `VERCEL_TARGET_ENV=dev` there, where `VERCEL_ENV` reads
`preview` ([System environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)).
Dev is a custom environment and not Preview because a Preview branch's variables, domain and
schedules belong to a branch of a connected Git repository, and this project is deliberately not
connected; Preview stays for throwaway builds. One project means one registry with no image
copy between two, one set of project settings, and one place to look.

**What keeps the environments apart now.** Each wall is a setting or a check, not a second
project:

- **Separate variable entries.** Every variable is an entry naming the environments it covers,
  and one entry is one value. No entry may cover the Production target and anything else
  (Preview, Development or `dev`), so no secret is shared. Production's secrets are typed by the
  founder, or written by the founder's scripts, into the Production target only. Once the
  Production target holds no dev value, the founder turns on the team policy **Separate
  Production Secret Values**, after which "each Secret must use a different value in Production
  than in Preview, Development, and custom environments"
  ([Config and Secret variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)).
  The orchestrator took Production off every dev entry on 12 Nov 2026 before production's own
  values went in, so the Production target holds production's values only. Whether the team
  policy is on yet is the founder's to confirm.
- **The boot guard.** A deployment whose `PONZU_ENVIRONMENT` disagrees with the Vercel
  environment it runs in (`VERCEL_TARGET_ENV`) never starts (`apps/api/src/env.ts`). So dev's
  values deployed with `--prod`, or production's in `dev`, stop at boot. An unset
  `VERCEL_TARGET_ENV` is logged and allowed, even for production, until the `environment_pair`
  line from a real deployment shows Vercel sets it.
- **The sandbox scope guard.** Our code, not Vercel, keeps dev's functions out of production's
  sandboxes (below).
- **Separate tokens.** The deploy workflow's dev job holds dev's `VERCEL_TOKEN` and its
  production job holds `VERCEL_TOKEN_PRODUCTION`, so each is revoked alone and Vercel's
  Activity Log names which deployed ("The production deploy, staged").
- **Public domains, protected everything else.** The project keeps Vercel Authentication under
  its current setting, the legacy Standard Protection (`prod_deployment_urls_and_all_previews`).
  That setting puts a custom environment's domain behind the login too: the first deploy to
  `dev` found `api-dev.ponzu.design` asking for one. So `api-dev.ponzu.design` is public through
  a **Deployment Protection Exception** for that one domain
  ([Deployment Protection Exceptions](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/deployment-protection-exceptions):
  "When you add a domain to Deployment Protection Exceptions, it becomes publicly accessible").
  The project's setting is unchanged, and every generated deployment URL and every preview stays
  protected. Do not switch the project to `all_except_custom_domains` to make `api-dev` public:
  the exception already does, and nothing about the switch has been tried.
- **Separate databases.** Dev is the Neon `dev` branch and production the default branch, and
  `apps/api/scripts/neon.ts` refuses the default branch except in the production deploy job.

**What is weaker than two projects, said plainly.**

- **OIDC is per project.** A deployment's OIDC token names its environment (its `sub` ends in
  `environment:<the custom environment's slug>`, [OIDC reference](https://vercel.com/docs/oidc/reference)),
  but Vercel Sandbox authenticates the project, not the environment. With two projects, dev's
  token could not reach production's sandboxes; with one it can, and only the scope guard below
  stops our code from doing so.
- **Any token for the project can deploy production.** Tokens have a project scope but no
  environment scope. The deploy workflow's own jobs are kept apart by name and by test, and the
  repository-wide `VERCEL_TOKEN` is to come from a member with the Developer role; whether that
  role really refuses `deploy --prod`, `promote` and `alias set` is not verified (experiment
  E13, "The production deploy, staged").
- **One variable list holds both environments' secrets,** so one ticked box can give a dev value
  to production or the reverse. The rule above, the team policy and the check (not built yet)
  contain it.
- **One firewall config.** The WAF is the project's, and Vercel's WAF pages say "Publish to
  apply the changes to your production deployment". Whether custom rules and rate limits apply
  to the `dev` environment's deployment, and whether dev and production share the per-IP
  counters, is not settled (experiment E14). Four rules count by IP alone (the sign-in exchange,
  `/v1/github/setup`, Claude sign-ins and the general per-IP limit), so if the counters are
  shared, dev's traffic counts against production's limits for the same address. Try a new rule
  scoped to `host eq api-dev.ponzu.design` first, then widen it. The `@vercel/firewall`
  rate-limit SDK needs Protection Bypass for Automation in a preview deployment
  ([Rate limiting SDK](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk)), and
  to Vercel a `dev` deployment is a preview (`VERCEL_ENV=preview`), so set
  `PONZU_RATE_LIMITS=vercel` on `dev` only after dev's logs show no `rate_limit_unavailable`.
- **A spend pause hits production, not dev.** Spend Management's pause "only affects production
  deployments", so it takes `api.ponzu.design` down and leaves `api-dev` serving ("Spend",
  below). Never pause the project to stop dev.
- **One registry.** A clean-up of old images in dev could delete what production runs. Never
  delete a digest that `main`'s `apps/runner/image/current.json` names.
- **Both environments' schedules live in one project.** Every `vercel schedules` command reads
  production unless told otherwise, so every dev command spells out `--environment dev`.

The sandbox image is built once, into the project's one Container Registry, and production pulls
the same digest dev checked (`apps/runner/image/current.json`), so production runs exactly the
bytes dev checked with no copy between registries.

### Sandboxes: our code check is the wall, not Vercel

With one project, Vercel does not keep dev out of production's sandboxes. Vercel Sandbox
authenticates per project ([Sandbox authentication](https://vercel.com/docs/vercel-sandbox/concepts/authentication):
"Each Vercel OIDC token belongs to one Vercel project"), its docs describe no limit by
environment, and Sandbox accepts the `dev` environment's token. So dev's functions, which run
the newest and least proven code on purpose, hold a token that could list, stop, delete and run
commands in production's sandboxes, which hold people's repositories and work in progress.

What keeps them apart is a check in `packages/sandbox` (`scope.ts`):

- Every deployment's sandbox module is made for one scope, and `vercelSandboxes` cannot be made
  without one. It refuses any call on a name outside its own `pz-<scope>-` prefix, and any
  listing not inside it, with `out_of_scope`, before anything is sent to Vercel. A listing that
  answers a name outside it is refused too, not filtered.
- A scope is the database's (`sandboxScope` in `apps/api/src/env.ts`: a hash of the Neon host
  without `-pooler` and the path, and nothing else). Production's database is Neon's default
  branch and dev's is the `dev` branch, with different hosts, so their scopes differ. The rule
  must never change: production's live sandboxes are named by it, and a new value for the same
  database would orphan them. `env.test.ts` pins the value for fixed URLs. What keeps a dev
  deployment from holding production's `DATABASE_URL` is that the value sits only on the
  Production target, and the boot check refuses a deployment whose `PONZU_ENVIRONMENT` and
  `VERCEL_TARGET_ENV` disagree.
- The minute's reconcile checks each listed name's scope again and never stops or removes one of
  another scope; it logs `sandbox_out_of_scope` instead.
- `scope.test.ts` tries every call of the module with other scopes' names, including names that
  merely begin with this scope's prefix, against the real module (no request may leave) and the
  fake (nothing may change). Removing the check fails it.

This guards against a mistake in our code, not against code written to get round it, so a
review of any change to `packages/sandbox/src/scope.ts`, `names.ts` or `sandboxScope` is a
production review.

Not verified: whether Vercel Sandbox's concurrency limit (10,000 running sandboxes on Pro,
[Sandbox pricing](https://vercel.com/docs/vercel-sandbox/pricing)) counts per team or per
project. The page says only that it "is limited by plan"; it speaks of a team for the vCPU and
deletion quotas, which suggests the team but does not say so. If it is per project, dev's load
now competes with production's for it.

## The desired state: `infra/`

Public values only. Secrets never go in the repository.

| File | What it says |
|---|---|
| `environments.json` | Who talks to what in each environment, and which environment a release desktop build bakes in (`release`) |
| `vercel-firewall.json` | The WAF: the OWASP core ruleset (log only), bot protection (log only), and the per-IP rules |
| `neon.json` | Realtime, compute, history, the backup schedule and branch protection, per environment |
| `r2/lifecycle.json`, `r2/cors.json` | The assets bucket's lifecycle rules and CORS |
| `cloudflare/assets-headers.json` | The response header rule on the asset hosts |
| `github/ruleset-main.json`, `github/ruleset-cloud.json` | The branch rulesets, in the shape GitHub's API takes |
| `github/repo.json` | Merge settings, the environments, and the names of every variable and secret the workflows read |
| `github-app/ponzu-dev.json`, `github-app/ponzu.json` | Each GitHub App's manifest, named by its slug: name, homepage, webhook and setup URLs, permissions and events. The check holds each App to its own file, and a test holds the two files to the same permissions, events and URLs; only the name differs |
| `posthog.json` | Project settings both PostHog projects must have |

The rules of `environments.json`:

- `null` means **not created yet**. Anything that reads the file shows it as `pending`, with
  the founder step that creates it, and never as a pass.
- `false` means **absent on purpose**: dev has no private bucket (its checkpoints sit in the
  assets bucket) and no minimum client versions.
- `neonBranch: "@default"` is the Neon project's default branch, whatever it is called.
- `release` is `"production"` since the cutover: a release desktop build talks to production.

Two commands read it:

```sh
bun scripts/prod/desired.ts status production          # every field: ok, none or pending
bun scripts/prod/desired.ts assert-release production  # exit 1 unless release is production and nothing is pending
```

`assert-release production` exits 0 now that `release` is production and the founder's steps
filled the production fields (WorkOS's client id, the Realtime URL, the PostHog project id). It
fails when any production value that says where to connect (the API, WorkOS, Realtime, assets,
the GitHub App, the Neon branch, a bucket, the PostHog project) is the same as dev's, or when
both environments name the same Vercel project and the same Vercel environment
(`vercelProject` and `vercelEnvironment`: both are `ponzu-api`, production on `production`, dev
on `dev`). Dev's `apiUrl` and `apiDomains` are `api-dev.ponzu.design`, so the API is no longer
one of the reasons.
Production's `r2.private` may be `null` until the bucket exists, but never `false`. The release
workflow runs it, from the tag being released, before it publishes ("The release talks to
production" in release.yml), so no release can ship pointing at dev. A dry run publishes
nothing and is not held by it.

The desktop build reads the same file (`apps/desktop/scripts/build.ts`): a release bakes the
environment `release` names and Ponzu Dev bakes dev's, and a `null` among the fields the app
uses (`apiUrl`, `workosClientId`, `realtimeUrl`, `assetsUrl`) fails the build.

## Every resource, and what is right

### Vercel `ponzu-api`

The one project, for both environments. It exists, so `bun scripts/prod/apply.ts vercel-project
--env production` (see [Applying the desired state](#applying-the-desired-state)) finds it and
only shows, and with `--yes` sets, the settings and Production variables that differ; it never
needs to create it.

| Setting | Value |
|---|---|
| Project | root `apps/api`, framework `hono`, function region `iad1`, Node as `engines.node` says |
| Git | not connected |
| OIDC | issuer mode team |
| Protection | Vercel Authentication under the legacy Standard Protection (`prod_deployment_urls_and_all_previews`), plus a Deployment Protection Exception for `api-dev.ponzu.design` and no other |
| Custom environments | one, `dev`, with no branch matcher (Pro includes one per project) |
| Legacy Cron Jobs | `vercel.json` still carries the minute's cron, which runs only on the Production target; **Disable Cron Jobs** is turned on once production's schedule has fired ("The minute"), and a later change removes the entry |
| Forbidden env names, in every environment | `VERCEL_TOKEN`, `BOAT_API_KEY`, `PONZU_SANDBOX_SNAPSHOT` |
| Variable entries | none covers the Production target and any other environment |
| Container Registry | `ponzu-runner`, holding `apps/runner/image/current.json`'s digest |
| Firewall | `infra/vercel-firewall.json`, one config for the project |
| Spend Management | team-wide: an alert, then a pause; the amounts are the founder's |

Per environment:

| | Production target | `dev` environment | Preview |
|---|---|---|---|
| Env | production's list under [Env and secrets](#env-and-secrets), in Production-only entries | dev's 27 names, including its own `PONZU_ENVIRONMENT=dev` and `PONZU_API_URL=https://api-dev.ponzu.design` | dev's values, with `PONZU_ENVIRONMENT=preview` and `PONZU_API_URL=https://api-dev.ponzu.design` |
| Domain | `api.ponzu.design`; **Auto-assign Custom Production Domains** off, so only a promotion moves it | `api-dev.ponzu.design`, public through the exception | none: generated URLs only, all protected |
| Schedule `minute` | active, created when the first production deployment that carries it becomes current (beside the legacy cron until that is disabled) | turned on once with `vercel schedules enable minute --environment dev` | runs no steps: the route answers none on `preview`, whatever the schedule's state (a CLI preview's copy belongs to the user who deployed, and its initial state is not documented) |
| Deploys | `deploy --prod --skip-domain` from `main`, then `vercel promote` (the workflow); `deploy --prod` from `main` by the orchestrator until then | `deploy --environment dev` from `main` | `deploy` by hand, throwaway |
| Going back | `vercel promote` or `vercel rollback`, in this runbook only | deploy the older commit with `--environment dev` | nothing to go back to |

### Neon

The existing project. Production is its default branch, dev its `dev` child branch, and
production starts empty: nothing is copied from dev, and people sign in again. On the
production branch (`infra/neon.json`):

| Setting | Value |
|---|---|
| Realtime | on |
| Compute | scale-to-zero off (`suspend_timeout_seconds: -1`), autoscaling 0.5 to 2 CU |
| Point-in-time history | 7 days |
| Backup schedule | daily at 07:00 UTC, kept 35 days (needs a paid plan) |
| Branch protection | on, if the plan offers it |
| Before each production migration | a snapshot `pre-<sha12>`, kept 14 days |

Scale-to-zero is off because a waking database eats the health check's 3 seconds and every
outbound call's 10. The API's `DATABASE_URL` is the pooled URL; migrations use the direct URL.

Because dev and production share a project, a Neon API key for dev also reaches production.
`apps/api/scripts/neon.ts` refuses the default branch, and the production deploy job is the
only thing that sets the guard that lets it through (`PONZU_ALLOW_DEFAULT_BRANCH=production`,
on its snapshot and migration steps; `scripts/ci/workflows.test.ts` fails if anything else sets
it).

### Cloudflare R2 and the `ponzu.cloud` zone

- Buckets `ponzu-assets` and `ponzu-private`, location hint ENAM.
- `ponzu-assets` is served only at `assets.ponzu.cloud`; r2.dev is off. `ponzu-private` has no
  domain, and `R2_PRIVATE_BUCKET` is set from the first day.
- Lifecycle (`infra/r2/lifecycle.json`): objects under `staging/` expire after a day, and
  incomplete multipart uploads abort after a day. **No rule touches `private/`**: a rule cannot
  tell a recorded checkpoint from an unrecorded one, so the API's own sweep deletes unrecorded
  archives instead. The schema refuses any rule whose prefix is inside `private/`, and any
  delete rule whose prefix contains it (an empty prefix, `p`, `priv`).
- CORS (`infra/r2/cors.json`) is dev's, copied: `GET`, `HEAD` and `PUT` from any origin, any
  request header, `ETag` exposed, cached a day. It was read from `assets-dev.ponzu.cloud`'s own
  answers to a preflight and a GET, since no Cloudflare token was at hand. Any origin is safe
  here: an upload is a presigned PUT whose signature is its authority, no request carries a
  cookie, and every object is public anyway. It is wider than the minimum (`ponzu-studio://app`
  and `https://ponzu.design` with the four headers an upload is signed with) because canvas pages
  rendered elsewhere, such as in a sandbox's browser, ask for fonts and media with CORS from
  origins of their own. The check fails if the file ever stops allowing that minimum.
- The API's R2 token is scoped to exactly those two buckets, Object Read and Write.
- A Response Header Transform Rule on `assets.ponzu.cloud` sets
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and
  `X-Content-Type-Options: nosniff`, the "second wall" behind serving user content from its
  own domain. Required in production, optional on `assets-dev.ponzu.cloud`.

### The WAF (`infra/vercel-firewall.json`)

| Rule | Limit |
|---|---|
| `/v1/cron/` with no `Authorization` header | deny |
| `POST /v1/auth/exchange` | 20 a minute per IP |
| `/v1/github/setup` | 30 a minute per IP |
| `/v1/claude/sign-ins` | 20 every ten minutes per IP |
| everything under `/v1/` except `/v1/runner/`, `/v1/github/webhook` and `/v1/cron/` | 1,200 a minute per IP |

The OWASP core ruleset runs in log mode for every category, because canvas HTML in ops matches
its XSS rules; the schema refuses `deny` on xss and sqli. Bot protection logs. Nothing on the API
host ever challenges, because the apps cannot solve a challenge, and Attack Challenge Mode is
never turned on for it.

Every rate-limit rule counts in a fixed window of at most ten minutes, because that is all Vercel
Pro offers (D1); a token bucket and an hour's window are Enterprise's, and a rule asking for
either would be refused when applied. So the planned hourly limits (the sign-ins per IP, and
canvas creates, uploads, GitHub sync and a runner's git credentials per caller) keep their
numbers in ten-minute windows: up to six times looser over an hour, never tighter, and a person
held back waits at most ten minutes. The general per-IP limit is a fixed window of 1,200 a minute
rather than the planned token bucket. `desired.test.ts` refuses any rule Pro cannot take. On
Enterprise the windows could go back to an hour, in the file and in `rate-limits.ts` together.

The same file holds one rule for each per-caller limit the API checks in code through
`@vercel/firewall`. Each rule's only condition is its rate-limit id (`rate_limit_api_id`); the API
says which id a request counts against and passes the person's or the canvas's id as the key, so
the rule counts per caller, not per address.

| Rate-limit id | Limit | Counted per |
|---|---|---|
| `user-writes` | 300 a minute | person (every other POST, PATCH or DELETE) |
| `canvas-creates` | 30 every ten minutes | person |
| `messages` | 60 a minute | person |
| `uploads` | 120 every ten minutes | person |
| `live` | 120 a minute | person |
| `github-sync` | 30 every ten minutes | person |
| `runner` | 3,000 a minute | canvas (every other runner call) |
| `runner-git` | 240 every ten minutes | canvas |

`apps/api/src/http/rate-limits.ts` names the ids and the routes; the numbers live in the rules.
`rate-limits.firewall.test.ts` fails when the code names an id the file has no rule for, when the
file has a rule for an id the code never names, or when a rule's numbers differ from the code's
table (which the test fake counts to). `/v1/runner/models` has no rule: the runner protocol
throttles it. These limits stay off (`PONZU_RATE_LIMITS=off`) until the rules are applied, and
they fail open: a check that takes over 500 ms, fails or finds no rule lets the request through.

The rule JSON follows Vercel's documented REST shape and `@vercel/sdk`'s firewall config types.
Two things are not proven until a person compares them with a rule made in the dashboard
(`vercel firewall rules inspect --json`), which the apply and check scripts need anyway: the exact
condition of a `@vercel/firewall` rule (pinned in
`apps/api/src/deps/fixtures/firewall-rate-limit-rule.json`), and what its `keys` must be when the key comes from code (the
file says `ip`, the dashboard's default; the SDK's own key replaces it). Nor is the SDK proven
inside the bundled API on Vercel: after the rules are applied on dev, one id with a 2-a-minute
rule is hit three times and the third must answer 429. Vercel counts per region, so a caller
whose requests reach two regions could make up to twice a limit; the API runs in one region
(`iad1`), so this is not expected to matter.

### DNS

`api.ponzu.design` and `api-dev.ponzu.design` point at Vercel and answer `/v1/health`;
`assets.ponzu.cloud` answers with the CSP header; `ponzu.design` serves the site.

### The GitHub App `ponzu`

Created from `infra/github-app/ponzu.json` by `bun scripts/prod/github-app.ts create --env
production --workos-callback <url>`, which the founder runs and confirms on GitHub's page.

- Public, with the same permissions and events as `ponzu-dev`.
- Webhook `https://api.ponzu.design/v1/github/webhook`, JSON, SSL verification on.
- Setup URL `https://api.ponzu.design/v1/github/setup`, with `setup_on_update`.
- Callback URL: WorkOS production's GitHub callback. `request_oauth_on_install` off.
- Its client secret, private key and webhook secret go straight into ponzu-api's Production
  target only, as Secrets; the script prints only the slug, the App id and the client id.

What the script does, in order:

1. It reads first, and stops before anyone is sent to GitHub if anything is in the way:
   ponzu-api must exist; none of `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
   `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_BOT_USER_ID` may be set on
   its Production target (it makes a new App and never replaces an App's secrets);
   `GITHUB_APP_SLUG` may be set only to the slug infra names; and GitHub must show no public
   App by that slug. It needs `VERCEL_TOKEN` (and `VERCEL_TEAM_ID`, as `apply.ts` does).
2. It serves one page on `127.0.0.1`, on a port the system picks, and opens it in the browser.
   The page posts GitHub's manifest form to
   `https://github.com/organizations/north-brook/settings/apps/new?state=<random>`, carrying
   the file plus `redirect_url` (back to the page) and `callback_urls` (the WorkOS URL). It
   answers only requests addressed to `127.0.0.1` and its port, so a web page that points its
   own name at the loopback cannot read the form's state.
3. GitHub sends the browser back with a code. A request without this run's `state` is answered
   400 and the page keeps waiting, for up to 30 minutes. The code is exchanged through
   `POST /app-manifests/{code}/conversions`; every secret in the answer is handed to the
   redactor before anything else reads it. An App that is not north-brook's is not stored.
4. It looks up the bot user (`GET /users/ponzu%5Bbot%5D`), then stores, in one request to
   ponzu-api's Production target, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`
   and `GITHUB_WEBHOOK_SECRET` as sensitive, and `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG` and
   `GITHUB_APP_BOT_USER_ID` as plain (they are public). Then it reads the names and types back.
5. It prints only the slug, the App id and the client id. WorkOS also needs the client secret
   (D7), so that one value is written to a file only the founder's user can read, in a new
   directory under `$TMPDIR`, and deleted when the founder presses Enter.

If GitHub names the App differently (the slug was taken by a private App), the script stores
the real slug and says that `environments.json` and the manifest's file name must follow. If
Vercel refuses the write, or takes it but leaves a secret out, it prints what is missing (for a
refusal, only Vercel's status) and how to finish by hand; the App then needs a new private key
and client secret from its settings page, because the script never writes them anywhere else.

`bun scripts/prod/github-app.ts create --env dev --dry-run` prints the form for an environment's
manifest and makes no request at all. It is what an agent may run. Without `--dry-run`, `--env
dev` is refused before any request: its secrets would land on ponzu-api's Production target, and
`ponzu-dev` exists already.

`api.github.com/apps/ponzu` answered 404 when this was written, so the slug is free or held by a
private App. If GitHub refuses the name, the App takes another slug, and `environments.json`
and `GITHUB_APP_SLUG` take it too.

### WorkOS production

- GitHub OAuth uses the `ponzu` App's client id and secret, so tokens are 8-hour App user tokens.
- Redirect URIs `http://127.0.0.1/auth/callback` (any port) and `ponzu://auth/callback`.
- Every sign-in method but GitHub off; default emails off.

The check cannot read WorkOS's configuration, so it proves it instead: it builds an authorize
URL for each redirect URI and requires a redirect to GitHub carrying the production App's client
id. WorkOS answers a redirect URI it does not allow with a redirect to its own AuthKit
`/redirect-uri-invalid` page, never to GitHub, so that fails too.

### PostHog "Ponzu"

Session recording, exception autocapture, console logs and heatmaps on (`infra/posthog.json`).
The group type `workspace` exists once the first event has come in; it cannot be made ahead.
Replay is `private` and AI content is off unless the founder chooses otherwise (founder step A4).

### Anthropic

A workspace "Ponzu production" with a monthly spend limit, and a key used only as
`PONZU_ANTHROPIC_API_KEY` for ideas and their gate.

### The GitHub repository

- `main` keeps its ruleset as it is, plus a merge queue ("Landing a change with a migration"):
  `infra/github/ruleset-main.json` is a copy of it with that one rule added, and a test compares
  the two field by field against a read-only recording.
- `cloud` gets a ruleset requiring "Conventional commit messages", "Check, typecheck, test",
  "Database on Postgres" and "Desktop package". A test checks each is a job name in `ci.yml`.
  It also requires a pull request, squash-merged, with no approval needed (as `main`'s does),
  and it has no bypass. Once it is applied nothing reaches `cloud` by a direct push, a revert
  included: a revert goes through a pull request like any other change.
- The environment `production`: the founder is the required reviewer, only `main` may deploy,
  and it holds `VERCEL_TOKEN_PRODUCTION`, `VERCEL_AUTOMATION_BYPASS_SECRET` and `NEON_API_KEY`
  (see "The production deploy, staged").
- The environment `dev`: no reviewer, only `main` may deploy, and it holds dev's own
  `VERCEL_TOKEN`. The deploy workflow's dev job runs in it. It does not exist yet ("Turning on
  the deploy workflow").
- The environment `release-signing`, as now.
- `infra/github/repo.json` names every variable and secret the workflows read; a test fails
  when a workflow reads one it does not name.

## The founder's steps

Production went live on 12 Nov 2026, so most of these are done; they stay here as the record of
how production was built and the order to rebuild it in. What is still open for the deploy
workflow is in "Turning on the deploy workflow" below. The steps refer to a frozen deployment at
`api.ponzu.design` and to D15 as the first production deploy: both are history now.

These are section D of the program's founder list, in order. Each turns on something already
built and tested, and none blocks a merge. Paste secrets only into the vendor's dashboard or into
ponzu-api's variables as a Secret, never into chat or a file in the repository. Every production
secret goes into the **Production target only**: never tick Preview, Development or `dev`
beside it.

Two dev steps:

- **B1. The dev environment and domain.** Done by the orchestrator on 12 Nov 2026: the custom
  environment `dev` exists, `api-dev.ponzu.design` is attached to it and serves, and the domain
  is public through a Deployment Protection Exception. Nothing for you, unless Vercel asks a team
  owner to approve something; if it does, approve it.
- **B6. The dev bucket.** R2 › the dev assets bucket › Lifecycle: delete objects under
  `staging/` after a day, and abort incomplete multipart uploads after a day. Add no rule on
  `private/`. Optionally, the header rule on `assets-dev.ponzu.cloud`.

Then production, when the program reports it is ready:

1. **D1. Plans.** Vercel Pro (already: the `dev` environment uses the one custom environment Pro
   includes, so no pack is needed). A Neon plan that allows scale-to-zero off and backup
   schedules (Launch or Scale). R2 billing on.
2. **D2. Vercel.** No new project.
   - Vercel › ponzu-api › Settings › Deployment Protection: confirm Vercel Authentication is on
     with the setting it has, and that `api-dev.ponzu.design` is the only Deployment Protection
     Exception. Open `https://api.ponzu.design/v1/health` and
     `https://api-dev.ponzu.design/v1/health` in a private window: both must answer JSON.
   - Settings › Security › OIDC Federation: confirm the **Team** issuer mode.
   - Settings › Environments › Production: turn off **Auto-assign Custom Production
     Domains**, so a production deployment takes `api.ponzu.design` only when promoted.
   - Team › Settings › Billing › Spend Management: an alert amount, then a pause amount (your
     numbers), and the webhook pointed at an alert to the orchestrator ("Spend"). It is
     team-wide, so it counts dev's spend too, but its pause stops only production.
   - Create `VERCEL_TOKEN_PRODUCTION`: a token scoped to the ponzu-api project, from an account
     with full production rights, used by nothing but the production deploy job. Keep it for
     D12.
   - Make sure the repository's and the `dev` environment's `VERCEL_TOKEN` come from a member
     with the Developer role and without Full Production Deployment, and that experiment E13
     has been run ("The production deploy, staged").
   - Run `bun scripts/prod/apply.ts vercel-project --env production` *(not built yet)*: it
     shows the difference between the project's settings and what this page says, and `--yes`
     applies it.
3. **D3. Neon.** Enable Realtime on the default branch. Run
   `bun scripts/prod/apply.ts neon --env production --yes`. Send the orchestrator the Realtime
   URL; it is public and goes in `environments.json`.
4. **D4. Cloudflare.** Create buckets `ponzu-assets` and `ponzu-private` (ENAM). Attach
   `assets.ponzu.cloud` to ponzu-assets and turn r2.dev off. Create an R2 token scoped to those
   two buckets (Object Read and Write; a secret, for D10) as an Account API token, so the check
   can see its scope, and a read-only Cloudflare token for the check (permissions under
   "Checking production"). Run `bun scripts/prod/apply.ts r2 --env production --yes` and
   `bun scripts/prod/apply.ts cloudflare-headers --env production --yes`.
5. **D5. WorkOS production.** Activate it, and copy the GitHub OAuth callback URL from
   Authentication › GitHub.
6. **D6. The GitHub App.** Run `bun scripts/prod/github-app.ts create --env production
   --workos-callback <the URL from D5>` with a `VERCEL_TOKEN` of your own that may write the
   Production target's variables (not the dev or repository token), in a browser signed in to GitHub as a north-brook owner, and click Create on
   GitHub's page. It writes the App's client secret, private key and webhook secret straight
   into ponzu-api's Production target and prints only the slug, the App id and the client id.
   Upload the logo. **Install it on north-brook/ponzu-test only after D15**: until then
   `api.ponzu.design` still serves dev's frozen deployment, which would receive the new App's
   setup redirects and webhooks for an App it does not know.
7. **D7. WorkOS production, continued.** Give GitHub OAuth the App's client id (printed by D6)
   and client secret (in the temporary file D6 names; press Enter afterwards to delete it). Add
   the redirect URIs `http://127.0.0.1/auth/callback` and `ponzu://auth/callback`; if the custom
   scheme is refused, tell the orchestrator. Turn off every method but GitHub, and default
   emails. Create an API key and add it to ponzu-api as the Secret `WORKOS_API_KEY`, Production
   only. Send the orchestrator the client id.
8. **D8. PostHog.** Free one project slot in the organisation (it is at its limit of six) and
   create the project "Ponzu". Run `bun scripts/prod/apply.ts posthog --env production --yes`
   and turn on cookieless tracking. Create a personal key with `person:write` and add it as the
   Secret `PONZU_POSTHOG_PERSONAL_API_KEY`, Production only. Create a source-map key, for D12.
   Send the orchestrator the project id.
9. **D9. Anthropic.** Create the workspace "Ponzu production" with a spend limit, and a key. Add
   it to ponzu-api as the Secret `PONZU_ANTHROPIC_API_KEY`, Production only.
10. **D10. Secrets and env.** First, wait for the orchestrator to report that the Production
    target holds no dev value any more: every entry that gave Production dev's value now covers
    only `dev` or Preview, and the old production entries of `PONZU_ENVIRONMENT`,
    `PONZU_API_URL` and `BOAT_API_KEY` are deleted. The frozen deployment at `api.ponzu.design`
    keeps working, since a deployment's values are fixed when it is built. Then, as team owner,
    turn on **Separate Production Secret Values** (Team › Settings › Security, the switch
    **Require Separate Values**). It covers Secrets only; the rule that no entry spans Production
    and another environment covers every entry. Then:
    - Run `bun scripts/prod/apply.ts secrets generate --names PONZU_VAULT_KEY,CRON_SECRET --env
      production --yes`, which writes 32 random bytes each to the Production target only and
      prints nothing.
    - Type in, as Secrets, Production only: `DATABASE_URL` (the default branch's pooled URL),
      `NEON_REALTIME_SECRET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (from D4),
      `EXPO_ACCESS_TOKEN` (a production token), and `RESEND_API_KEY` if email is used.
    - Run `bun scripts/prod/apply.ts vercel-env --env production --yes` for the public values,
      `PONZU_ENVIRONMENT=production` and `PONZU_API_URL=https://api.ponzu.design` among them.
    - Leave Preview and `dev` alone.
    - Check: `bun scripts/prod/check.ts --env production` shows every `env.*` line ok,
      including that no entry covers Production and another environment.
11. **D11. Domains.** Nothing moves: `api.ponzu.design` is already the Production target's
    domain, and dev has been on `api-dev.ponzu.design` since it moved. Confirm with the
    orchestrator that `infra/environments.json` names api-dev for dev, that
    `api.ponzu.design`'s logs have shown no app or runner traffic for a day, and that the rule
    denying every request to `api.ponzu.design` will be removed just before D15.
12. **D12. The GitHub repository.** Create the environment `production` with yourself as
    required reviewer and `main` as its only branch, holding the secrets
    `VERCEL_TOKEN_PRODUCTION` (from D2), `VERCEL_AUTOMATION_BYPASS_SECRET` (made in Vercel ›
    ponzu-api › Settings › Deployment Protection › Protection Bypass for Automation, named
    `deploy-production`; read "The production deploy, staged" first) and `NEON_API_KEY`.
    Create it, with its reviewer and its branch, before you set `API_DEPLOY_PRODUCTION`: GitHub
    creates an environment a job names that does not exist yet, with no reviewer, so the first
    deploy would run without your approval. Then add the variable `API_DEPLOY_PRODUCTION=true`.
    There is no second project id and no Container Registry policy to add: one project, one
    registry. Repoint the `PONZU_APP_POSTHOG_*` variables and the secret
    `PONZU_APP_POSTHOG_CLI_API_KEY` (the source-map key from D8) to the new PostHog project.
    Run `bun scripts/prod/apply.ts github-rulesets --yes`. Check that `RELEASE_TOKEN` expires
    after the cutover.
13. **D13. Releases and stores.** Set the repository variable `RELEASES_HELD=ponzu,mobile`.
    Check the Developer ID certificate's expiry. In the EAS environment `production`, set
    `EXPO_PUBLIC_PONZU_API_URL=https://api.ponzu.design`, WorkOS production's client id and the
    production PostHog key, all public.
14. **D14. Stripe live.** Activate live mode, repeat the test-mode setup with live keys (Secrets,
    Production only on ponzu-api) and a webhook on `https://api.ponzu.design/v1/stripe/webhook`,
    and set `PONZU_BILLING=on`, Production only, only after counsel and tax are settled.
15. **D15. The first production deploy.** Approve it in Actions: it snapshots, migrates the empty
    database, deploys without the domain, checks the new deployment, promotes it to
    `api.ponzu.design`, and checks that the `minute` schedule is active. Then run
    `bun scripts/prod/check.ts --env production --deep` until every line is `ok` or `manual`, and
    confirm each manual spend line. Sign in once against production on an account whose Claude
    is the dev key, and give the orchestrator the session file's path for the end-to-end run.
    Then install the `ponzu` App on north-brook/ponzu-test (moved here from D6).

After D3, D7 and D8, the orchestrator fills `environments.json`'s production nulls in one PR;
the cutover PR flips `release` to `"production"`, and `assert-release production` must then
exit 0. Cutover day itself, and how to go back, are in docs/cutover.md, written with the cutover
work.

Monthly, after cutover: `bun scripts/prod/restore-drill.ts --env production`.

## The production deploy, staged

Dev and production are one Vercel project, so any token for it can deploy production. The
deploy workflow (`.github/workflows/deploy-api.yml`) contains that in four ways, and
`scripts/ci/workflows.test.ts` pins each:

- **Dev never deploys production.** The dev job deploys with `--environment dev` and never
  `--prod`, `--skip-domain`, `promote`, `rollback` or `alias`. It runs in the GitHub
  environment `dev`, which only `main` may use.
- **Production has its own token, by name.** The production job reads
  `VERCEL_TOKEN_PRODUCTION`, which only the `production` environment holds. A GitHub
  environment secret only overrides a repository secret of the same name, so had it been called
  `VERCEL_TOKEN`, a `production` environment without one would have used the repository's
  token, which reaches the same project. A missing `VERCEL_TOKEN_PRODUCTION` reads as empty,
  and the job's first step fails before the database is touched.
- **A production deploy never takes the domain by itself.** The job deploys with
  `deploy --prod --skip-domain`, which builds a production deployment but leaves
  `api.ponzu.design` on the one before it
  ([vercel deploy](https://vercel.com/docs/cli/deploy)). It checks that deployment's own
  `/v1/health` (this commit, the image, every migration, `environment: production`), and only
  then runs `vercel promote <its URL>`. Promotion syncs the deployment's static schedules
  ([Schedules concepts](https://vercel.com/docs/schedules/concepts): "Promote a staged
  production build: synced from the promoted deployment"), so the job then checks
  `api.ponzu.design`'s health and that the `minute` schedule is active, not inactive and not
  enabled only for a while (`scripts/ci/schedules.ts`, which reads
  `vercel schedules list --json`, against `schedules.minute` in `apps/api/vercel.json`).
  Turning off **Auto-assign Custom Production Domains** on the Production environment as well
  makes a stray `--prod` from anywhere else unable to take the domain. That is a dashboard
  setting, required before D15 (founder step D2), and not checked by anything until the check
  per environment is built ("Checking production").
- **`vercel promote`, `vercel rollback` and `vercel alias set` belong to production only:**
  to this job and to this runbook. Promoting a deployment that is not a production build
  "will result in a new production deployment" ([vercel promote](https://vercel.com/docs/cli/promote)),
  built from that code with production's variables, so promoting a dev deployment would put
  a build nobody approved for production on `api.ponzu.design`. The job's promote passes no `--yes`, and with
  `--json` the CLI 65.14.0 then refuses such a promotion and exits 1 rather than rebuilding
  (read from the CLI's own code). Dev is taken back by deploying an older commit with
  `--environment dev`, never by promoting, rolling back or aliasing.

**What the staged check uses, and what you must know about it.** The new deployment is reached
at its generated `https://<name>.vercel.app` address, which Vercel Authentication protects: the
project's setting protects every deployment URL that is not the current production one. The
check gets through with a **Protection Bypass for Automation** secret, sent as the
`x-vercel-protection-bypass` header
([Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)).
You make that secret on purpose in D12 and store it only in the `production` GitHub environment
as `VERCEL_AUTOMATION_BYPASS_SECRET`; the job fails at its first step without it.
`scripts/ci/health.ts --bypass` sends it only to a `*.vercel.app` address, never to a custom
domain. Know three things about it:

- **It opens every deployment of the project,** dev's and previews' included, not only
  production's: "You can use each available secret to bypass Deployment Protection on all
  deployments in a project until the secret is revoked." With one project there is no way to
  limit it to production's. Treat it like a production secret, and revoke it at once if it
  may have leaked.
- **Vercel also puts it in every deployment** as the system variable
  `VERCEL_AUTOMATION_BYPASS_SECRET` (the page above), so dev's and previews' code can read it.
  Nothing in the API reads it. It gets a request past Vercel's login wall, and also past the
  firewall's system mitigations and bot protection outside an attack, but never past the API's
  own checks (sign-in, the cron bearer). Whether it skips the firewall's custom rules that page
  does not say.
- **The job does not use `vercel curl`.** That command "automatically handles deployment
  protection bypass tokens" ([vercel curl](https://vercel.com/docs/cli/curl)). The docs do not
  say how, but the CLI 65.14.0's own code does: given no `--protection-bypass` and no
  `VERCEL_AUTOMATION_BYPASS_SECRET` in its environment, `vercel curl` on a protected project
  that has no bypass secret creates one for the whole project and prints "Added a Protection
  Bypass for Automation secret to project …". `vercel httpstat` and `vercel deploy --verify` do
  the same. That was read from the code and not tried. ponzu-api had no bypass secret when the
  plan was checked, so the first of these run against it, by anyone, would make one as a side
  effect. `scripts/ci/workflows.test.ts` fails if any workflow runs them. If you or the
  orchestrator ever run one against ponzu-api by hand, look under Settings › Deployment
  Protection afterwards for a bypass you did not make, and revoke it.

**What the workflow does not contain.** The four rules above keep the deploy workflow's own
jobs apart. They do nothing about the repository-wide secret `VERCEL_TOKEN`, which `image.yml`
and `claude-code.yml` also read. `claude-code.yml` runs daily from `main`, and
its "e2e.ts scratch" step runs a newly published Claude Code and Agent SDK from npm with that
token in its environment. With one project, a token from a team member with full rights can
deploy `--prod`, promote, set aliases and change the Production target's variables, so that
token is a path to production. The containment is to mint the repository's and the `dev`
environment's `VERCEL_TOKEN` from a member with the Developer role and without the Full
Production Deployment extension ([Access roles](https://vercel.com/docs/rbac/access-roles)),
and to keep `VERCEL_TOKEN_PRODUCTION` from someone who has it. Whether that role really
refuses `deploy --prod`, `promote` and `alias set` is not verified: try each with such a token
on a throwaway project and expect a 403. Production is live, so this is owed now.

The alternative, not taken: leave production's generated URLs unprotected and check them with
no secret. That needs a change to the project's protection setting, which also covers dev's and
previews' generated URLs, and nothing about it has been tried.

## Turning on the deploy workflow

`deploy-api.yml` runs only for a push to `main` (and, for dev alone, a dispatch on `main`); no
job runs for a pull request, another branch or a tag. Each job is off until its own variable is
`true`, and the two are independent: `API_DEPLOY` never deploys production, and
`API_DEPLOY_PRODUCTION` never deploys dev. `scripts/ci/workflows.test.ts` evaluates both jobs'
conditions for every event, branch and combination of the two variables and pins the answer.

What each job reads, and what existed when this was written (13 Nov 2026, from `gh variable
list`, `gh secret list` and the repository's environments, names only):

| Job | Reads | Exists |
|---|---|---|
| `dev` | variable `API_DEPLOY` | no |
| `dev` | variables `VERCEL_TEAM_ID`, `VERCEL_API_PROJECT_ID` | yes |
| `dev` | variable `NEON_PROJECT_ID` | no |
| `dev` | secret `VERCEL_TOKEN` (the `dev` environment's, else the repository's) | the repository's only; no `dev` environment |
| `dev` | secret `NEON_API_KEY` (the repository's) | no |
| `production` | variable `API_DEPLOY_PRODUCTION` | no |
| `production` | variables `VERCEL_TEAM_ID`, `VERCEL_API_PROJECT_ID` | yes |
| `production` | variable `NEON_PROJECT_ID` | no |
| `production` | secrets `VERCEL_TOKEN_PRODUCTION`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `NEON_API_KEY`, all from the `production` environment | no; no `production` environment |

So to turn on dev: add the repository variable `NEON_PROJECT_ID` and the repository secret
`NEON_API_KEY`, create the environment `dev` limited to `main` with dev's own `VERCEL_TOKEN`
(optional but intended: until then the repository's token deploys dev), then set
`API_DEPLOY=true`. To turn on production: create the environment `production` with the founder as
required reviewer, limited to `main`, holding the three secrets, **before** setting
`API_DEPLOY_PRODUCTION=true` (GitHub creates a missing environment with no reviewer). Both are
the founder's (D12). `bun scripts/prod/check.ts --env production` lists each one still missing as
`pending`.

## Landing a change with a migration

Many lanes merge to `main` without knowing about each other, and a merge to `main` migrates the
database before the API that merge built goes live. Three things make that safe without a
person keeping the order: the merge queue, the migration guard and the contract. All three run
in CI's **Migrations** job (`.github/workflows/ci.yml`), on every pull request, every merge-queue
entry and every push to `main`, and "Check, typecheck, test", the check `main` requires, passes
only when that job did.

### The merge queue

`infra/github/ruleset-main.json` adds GitHub's merge queue to `main`'s ruleset. Once applied:

- A green pull request is not merged directly. It joins the queue, and GitHub tests it as `main`
  with every entry ahead of it and itself on top (`ci.yml` runs on `merge_group`). It merges only
  when every required check passes there too. Two pull requests that are green alone and break
  each other cannot both merge: the second fails in the queue and is taken out.
- One entry merges at a time (`max_entries_to_merge: 1`), squashed, so every merge is its own
  push to `main` with its own migration and its own deploy. Up to five entries are tested at once
  (`max_entries_to_build: 5`), and each must pass on its own (`ALLGREEN`). An entry whose checks
  have not answered in 60 minutes is taken out.
- Release Please's release pull requests still merge themselves. `release.yml` turns on
  auto-merge with `gh pr merge --squash --auto`; on a branch with a merge queue that puts the
  pull request in the queue once its checks pass (`gh pr merge --help`: "no merge strategy is
  required"; the `--squash` is ignored and the queue squashes). A release pull request that
  `scripts/release-hold.ts` holds loses auto-merge as before, and if it is already in the queue
  it is also taken out of it (turning auto-merge off does not do that). So is a release pull
  request whose hold could not be decided.

**What changes for a person merging by hand.** The button says "Merge when ready" and adds the
pull request to the queue; it merges some minutes later, after the queue's run. From a terminal,
`gh pr merge <number> --squash` does the same (with `--auto` it waits for the checks first). No
one can skip the queue: the ruleset has no bypass, so `gh pr merge --admin` is refused too. To
take a pull request out of the queue, use "Remove from queue" on the pull request. A held release
pull request is merged the same way, and so joins the queue like any other.

**Applying it** is the founder's or the orchestrator's (an agent only reads):

```sh
gh api repos/north-brook/ponzu/rulesets/25478973            # main's ruleset as it is now
gh api -X PUT repos/north-brook/ponzu/rulesets/25478973 --input infra/github/ruleset-main.json
GH_TOKEN=$(gh auth token) bun scripts/prod/check.ts --env dev   # github.ruleset.main: ok
```

`bun scripts/prod/apply.ts github-rulesets --yes` does the same, and also creates "Protect
cloud" for the retired `cloud` branch, which is harmless. Until it is applied, the check reports
`github.ruleset.main` as `pending` ("has no merge_queue rule yet"), not `fail`; with the rule
applied and different from the file (another merge method, more entries at a time), it fails.
The queue needs nothing else: the required checks keep their names, and every job in `ci.yml`
already reports on a queue entry.

### The migration guard

`bun scripts/ci/migration-guard.ts check --base <ref>` judges the change's migrations against
`<ref>`'s: the merge commit's base on a pull request, the entry ahead of it in the queue, the
commit before it on a push. It fails, naming the file and line, when:

- the new migration is not the next after the base's newest: its number is taken, the base's
  newest is missing from its journal, or its `when` is older than the base's newest (`db:migrate`
  would skip it);
- its drizzle snapshot does not follow the base's newest snapshot (`prevId`), or the numbers, the
  journal, the files and the snapshot chain disagree anywhere;
- it edits or deletes a migration the base has (applied migrations never change);
- it adds more than one migration;
- it is not expand only: the statements `scripts/ci/migrations.ts` refuses (DROP of a table,
  column, index, type, extension, function or sequence, a column's DEFAULT dropped, RENAME, a
  type change, SET NOT NULL, ADD COLUMN … NOT NULL without a default, TRUNCATE), unless a
  `-- contract:` line says why it is safe now;
- a statement names a table the base already has before `lock_timeout` is set. Each such
  statement holds a lock on that table until the migration commits, so a long transaction on it
  would hold every request behind the migration. The migration's first statement is then
  `SET LOCAL lock_timeout = '5s';--> statement-breakpoint`, under a `-- hand-written (…)` line, as
  in `0031_search`. A timeout of zero or DEFAULT is no timeout and does not count. A migration
  that only creates new tables needs none.

When another lane's migration took the number first, the failure prints what to run:

```sh
git fetch origin && git merge origin/main     # a conflict in packages/db/migrations is fine
bun scripts/ci/migration-guard.ts renumber    # against origin/main; --base <ref> for another
git add packages/db/migrations && git commit
```

`renumber` does the renumbering by itself: it takes `main`'s journal and snapshots, deletes the
branch's own migration, runs `db:generate` again under the next number (so the `when` is newer and
the `prevId` is `main`'s newest), and puts the hand-written lines back. When Drizzle writes the
same statements as before, the old file goes back whole under its new number; when it does not
(`main` changed the same tables), it stops and prints the hand-written lines to paste. It then
checks that a second `db:generate` finds nothing to do and that the guard passes. The migration's
own tests that look it up by name keep working; a test that expects it to be the newest has to be
changed by hand.

Tried on the live example: `#586` (`0032_billing`) merged into a copy of `main`, then `#602`
(`0032_email`) merged on top of it. The guard failed `#602` with the renumber advice, `renumber`
made `0033_email` (the same SQL, the snapshot following billing's), and the guard then passed. In a
real queue `#602`'s entry would not even build: both add `meta/0032_snapshot.json`, so GitHub finds
a merge conflict and takes it out of the queue; the guard is what catches the cases that merge
cleanly.

### The contract: the API from before the merge on the new schema

For the minutes a deploy takes, and for good after a rollback, the API that was live before the
merge runs on the schema the merge's migration makes. `bun scripts/ci/migration-contract.ts
--base <ref>` proves it can: it takes the base's code, puts the change's migrations in its place,
and runs the base's own tests of its database code there (`packages/db` and `apps/api`, about 140
files), every test database built from the new migrations. In CI it also applies them to a
Postgres 18 with the base's `db:migrate` and runs the base's `*.live.test.ts` there. Left out are
`packages/db/src/schema/`, whose tests are about the migrations themselves (true of the change,
not of the base), and the API's surface and vendor tests, which reach no database. Without a new
migration it passes at once. It replaces the "old API's inserts still go" tests written by hand in
`#552` and `#602`, which wrote the old API's rows themselves; this runs the old API's own code.

The PGlite tests run side by side and the Postgres ones one file at a time, as "Database on
Postgres" runs them, since they share one database. With `--head <ref>` it reads the change's
migrations from a ref, so a pull request can be tried without checking it out.

Tried, on a local Postgres 15 (CI's is 18): `main`'s code on `#602`'s schema and on `#586`'s each
pass (1,771 tests on PGlite, 38 on Postgres). `main`'s code on `#602`'s schema with a column
`main` reads dropped behind a lying `-- contract:` line, which the guard lets through, fails 705.

### A lane's migration, start to finish

1. Change `packages/db/src/schema`, then `bun run db:generate --name <feature>` in
   `packages/db`. Add hand-written lines under `-- hand-written (<why>)`; if the migration touches
   a table that exists, the first is `SET LOCAL lock_timeout = '5s';`.
2. Write the API so the old one keeps working on the new schema (add, never take away), and the
   new one is safe on the old schema only if it can be (Drizzle's `select()` names every column, so
   usually it is not; the deploy migrates first).
3. Before pushing: `bun scripts/ci/migration-guard.ts check --base origin/main`,
   `bun scripts/ci/migration-contract.ts --base origin/main` and `bun test packages/db`.
4. Open the pull request. CI's Migrations job runs the same against its base.
5. Whoever lands it adds it to the queue. If the queue or the guard says the number is taken,
   renumber as above, push, and add it again.
6. Once merged, `deploy-api.yml` migrates and deploys ("The production deploy, staged"). Nobody
   runs a migration by hand.

**Not proven.** No merge queue has run on this repository yet, and no queue entry has run the
Migrations job. The contract checks the code of the commit right before the merge, not the code
that is actually live: if two merges with migrations deploy as one (a deploy that skips a queued
older commit), the API live before both runs on two migrations that were each checked only
against their own base. The lock rule finds a table by its quoted name, or unquoted after a word
that takes a table; a name built in dynamic SQL is not found. The lint does not catch a
constraint narrowed on data that exists (a CHECK or UNIQUE added to an existing column), or a
DELETE; the contract catches what the old API's own tests exercise, and a reviewer the rest. And
the release notes ride on the squash commit's body (`squash_merge_commit_message: PR_BODY` in
`infra/github/repo.json`): that the queue's squash takes the repository's commit message settings
has not been seen yet, so look at the first queued `feat:` or `fix:` commit on `main` and at the
release pull request that follows it.

## The minute

The API's minute (`GET /v1/cron/minute`: job retries, the sandbox sweep, and the hourly steps)
is moving from the legacy Cron Jobs to a Vercel Schedule, `minute` in `apps/api/vercel.json`.
Vercel keeps one copy of a static schedule for production and one for each custom environment
([Schedules concepts](https://vercel.com/docs/schedules/concepts)), while a legacy cron runs only
on the Production target. So today dev has no minute at all, and production runs on the cron.

`vercel.json` carries both: the legacy `crons` entry and the `minute` schedule. That is on
purpose, so production never goes a minute without a run while it moves. While both are on,
production runs the route twice for each minute, which the steps allow: `runCronSteps` takes only
what nobody else holds, and a slotted step records its slot once (`recordOnce`).

- **Production's** schedule is created active when the first production deployment that carries
  it becomes current ("Vercel applies a deployment's static schedules when that deployment
  becomes the current deployment of its environment"). Once `vercel schedules executions list
  minute` shows it firing with 2xx answers, the orchestrator turns on **Disable Cron Jobs**
  (Vercel › ponzu-api › Settings › Cron Jobs). That needs no deploy, and turning it off again
  brings the cron back at once, so it is the way back if the schedule ever stops. A later change
  removes `crons` from `vercel.json` once the schedule has run cleanly for a while; until then
  the check's `vercel.crons` line fails, saying both run.
- **Dev's** is created inactive by dev's first deploy that carries it and is turned on once with
  `vercel schedules enable minute --environment dev`. It stays as it was set across later deploys
  ([Managing Schedules](https://vercel.com/docs/schedules/manage)). apps/api/README.md,
  "Schedules", has the commands. Dev never ran the legacy cron.
- **Preview** never runs it: the route answers no steps on `PONZU_ENVIRONMENT=preview`. That
  refusal is the wall, not the schedule's state. This project is not connected to Git, so a
  preview is a CLI deployment, and Vercel keeps a copy per user for those; the docs give Preview
  branches' copies an inactive start but say nothing of a CLI user's (not verified: list them
  with `vercel schedules ls --user <user id>` after a preview deploy).

Each run records when it ran in the database. `/v1/health` reports it as `cron.lastRanAt`, the
selfcheck's `cron_fresh` fails when it is five minutes old, and the uptime check counts that as
production down. Schedules are in beta, start within a one-minute jitter, and are not retried
(docs/cloud.md, "Known constraints").

**Going back to the cron alone.** Turn **Disable Cron Jobs** off (the setting "persists across
deployment promotions and Instant Rollbacks… they remain disabled until you explicitly re-enable
them", [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)), confirm the
project's `crons.disabledAt` is null, then run `vercel schedules disable minute` for production
once; that state sticks across deploys. This works only while `vercel.json` still carries
`crons`; after the later change removes it, putting the entry back and deploying production
comes first. A rollback to a deployment without the schedule deletes production's copy, and the
next deploy recreates it active, so after one, disable it again if the cron is meant to be the
only run.

**Rolling production back once Disable Cron Jobs is on.** Every production deployment before
this change carries the cron and no schedule. Rolling back to one of them deletes production's
schedule, and the cron does not come back by itself, because Disable Cron Jobs survives a
rollback. Production would then have no minute at all: no job retries, and no sandbox put to
sleep. So turn **Disable Cron Jobs** off first, confirm `crons.disabledAt` is null, and only then
run `vercel rollback`. Before Disable Cron Jobs is turned on, a rollback needs nothing extra.

## Checking production

`bun scripts/prod/check.ts --env dev|production [--json] [--deep]` is read-only and never asks
a vendor to decrypt a value.

- It reads credentials from the environment of whoever runs it: `VERCEL_TOKEN` (and
  `VERCEL_TEAM_ID`, optional for the read-only lines; without it the team is named by its public
  slug), `NEON_API_KEY` with `NEON_PROJECT_ID`, `CLOUDFLARE_API_TOKEN` (read only) with
  `CLOUDFLARE_ACCOUNT_ID` (R2's account id), `POSTHOG_PERSONAL_API_KEY` (read only, with
  `project:read`), `GH_TOKEN` or `GITHUB_TOKEN` (`GH_TOKEN=$(gh auth token)` as a repository
  admin: it must read the repository's administration, environments, secrets and variables),
  `RELEASE_TOKEN` (only so its expiry can be read from GitHub's answer to it), and `CRON_SECRET`
  for the selfcheck. A missing credential makes its section, or its line, `skipped`, never a
  pass. The GitHub App's lines and WorkOS's need no credential: what they read is public.
- The read-only Cloudflare token needs, on the account, Workers R2 Storage Read and Account API
  Tokens Read, and on the zone `ponzu.cloud`, Zone Read and Transform Rules Read. Without the
  token listing, the R2 token line fails and names the permission.
- Each line is `ok`, `fail`, `pending`, `manual` or `skipped`, with the runbook step or the
  `apply.ts` command that fixes it. It exits 0 only when every line is `ok` or `manual`; a
  `pending` or `skipped` line exits 1 like a `fail`.
- Every printed line goes through `@ponzu/core/redact`, with every credential present as a known
  secret, so even a vendor's error that quoted one would not print it.
- `--deep` also creates and removes one `pz-test-check-` sandbox from the current image, and
  needs `VERCEL_TEAM_ID` as well. On production it is the founder's to run.
- Agents never run `apply` or `check --deep` against production.

What each section checks:

| Section | Lines |
|---|---|
| `vercel` | The project exists (on production, `pending` until D2); root `apps/api`, the API's Node version, region `iad1`, no Git connection; OIDC with the team issuer; Standard Deployment Protection; the Production target holds every name `REQUIRED_ENV` lists and only names the API reads; no `FORBIDDEN_ENV` name on any target; on production, no entry on the Production target also covers another target (Preview may hold dev's values in entries of its own) and every secret is stored as sensitive; the environment's API domains are verified on the project; the live firewall equals `infra/vercel-firewall.json` (enabled, OWASP categories, managed rules, and each rule's conditions, action and limits); the latest production deployment is ready; no legacy cron is on; and the `minute` schedule `vercel.json` declares is a `manual` line, because the check does not read Vercel's Schedules API yet (the deploy job's `scripts/ci/schedules.ts` does). |
| `neon` | The environment's branch exists (dev's is not the default branch); Realtime is on at `environments.json`'s `realtimeUrl` (on production, `pending`, whether on or off, until D3 sends it). Where `infra/neon.json` asks (production): the read-write compute never sleeps (`-1`) and scales 0.5 to 2 CU; point-in-time history keeps at least 7 days; the backup schedule is daily at 07:00 UTC kept 35 days, and the latest scheduled snapshot is under 26 hours old (a deploy's own snapshot does not count; no schedule is `pending`, never a pass); the branch is protected. |
| `cloudflare` | The assets bucket exists (production's in ENAM), is served at the environment's assets host with an active certificate and at no other custom domain, has r2.dev off, has `infra/r2/cors.json`'s CORS exactly, and has `infra/r2/lifecycle.json`'s rules (none of them live is `pending`). A live lifecycle rule that would delete under `private/` fails, whatever the file says. Production's private bucket exists in ENAM with no domain, r2.dev off and no delete rule. An account API token reaches exactly the environment's buckets and no other (on dev, a token the account listing cannot show is `manual`). The transform rule on the assets host sets the headers `infra/cloudflare/assets-headers.json` names (dev may go without). |
| `github` | The environment's App, from GitHub's public answer: it exists and is `north-brook`'s (on production, `pending` until D6), and its permissions, events and homepage are its own manifest's exactly (`infra/github-app/<slug>.json`), so a permission the manifest does not grant fails. With a token: the merge settings are `github/repo.json`'s; each ruleset matches its file (enforcement, branches, no bypass, the same rules with at least the file's settings; `cloud`'s is `pending` until D12); each environment deploys only from its branches, has a required reviewer where the file says so, and holds its secrets (`production` is `pending` until D12); every variable and secret the workflows read is set (`pending` while any is not). A token that cannot read all of that is one `fail` line, and the App's lines are still judged. With `RELEASE_TOKEN`: GitHub accepts it and it expires more than 30 days from now. |
| `workos` | The client's JWKS has a signing key. For the Mac's loopback and the phone's `ponzu://` redirect URI, an authorize request built with `@workos-inc/node` redirects to GitHub with the environment's App's client id (any other client id, an error page or AuthKit's invalid-redirect page fails). Production is `pending` until D7 puts its client id in `environments.json`. The sign-in methods and default emails are `manual`. |
| `posthog` | The project `environments.json` names exists (production `pending` until D8), has `infra/posthog.json`'s settings, and has the group type `workspace` once it has had an event (before one, `pending`). |
| `api` | `/v1/health` answers as this environment, `ok`, with its database; applied migrations equal the build's; the image is current.json's; on production the commit is `main`'s head. Then each `/v1/cron/selfcheck` id is `ok`. The cron secret is sent only after health has said it is this environment, so dev's secret never reaches production. Until the cutover sets `release` to production in `environments.json`, production's address answering as dev (the frozen deployment) is `pending`, not `fail`; so is `cron_fresh` answering `never_ran` on production. |
| `dns` | Each of the environment's API domains, the assets host and `ponzu.design`: resolves over DNS-over-HTTPS, presents a valid certificate with at least 14 days left, and answers as it should (the API and the site from Vercel; the assets host with the header rule, which dev may go without). A production name not set up yet is `pending` with its founder step. |
| `spend` | The five spend alerts, each `manual`. |
| `deep` | With `--deep` only: the throwaway sandbox is made from current.json's image and removed. |

The Vercel section reads through `@vercel/sdk`. On 1.28.53 the SDK's own schema refuses dev's real
project answer (it requires a `traffic_sources` field the API does not send), so the check falls
back to the answer the SDK hands over with its validation error. The tests run that path on the
recorded answers (trimmed to the fields the check reads, which the SDK refuses too); the full
answer went through it once when it was recorded.

**Per environment, in one project** *(not built yet)*. The table above is what the check does
today. It was written for two projects and only adjusted for one: its `vercel` lines read the
Production target of the project `environments.json` names, which is now `ponzu-api` for both
environments, so run with `--env dev` they judge the Production target's names, the project's
domains and the latest production deployment, not dev's own. Entries scoped only to the `dev`
custom environment are not read at all. Until the work below lands, read `--env dev`'s `vercel`
lines with that in mind. Then `--env` names a Vercel environment of ponzu-api
(`vercelEnvironment` in `environments.json`), not a project, and its Vercel lines will check:

- **Variables.** An environment's entries are read by `target` for production and by
  `customEnvironmentIds` containing dev's id for dev. `REQUIRED_ENV`, the forbidden names and
  the unknown-name rule apply to each environment on its own.
- **Separation, without reading a value.** Any entry that covers the Production target and any
  other environment fails, whichever environment is being checked: one entry is one value, so a
  shared entry is a shared secret. Preview may hold dev's values, never production's.
- **Protection.** Vercel Authentication on with the project's setting, a Deployment Protection
  Exception for `api-dev.ponzu.design` and no other, and both API domains answering
  `/v1/health` without a login while a generated deployment URL asks for one.
- **Domains,** read by `customEnvironmentId`: `api.ponzu.design` with none (the Production
  target), `api-dev.ponzu.design` with dev's. For production, **Auto-assign Custom Production
  Domains** is off.
- **The minute.** That environment's `minute` schedule exists, is active (and not only for a
  while), and is a GET on `/v1/cron/minute`, and the project runs no legacy cron. Vercel's
  Schedules API answers 400 for a custom environment with no deployment yet, which reads as
  `pending`, not `fail`. The selfcheck's `cron_fresh` is checked with the rest of the selfcheck,
  and `never_ran` on production before its first run is `pending`.
- **The latest deployment** is the newest READY one in that environment.
- **The firewall** is one config for the project, so it is checked once, under either
  environment.

`apply.ts` will work the same way: `vercel-project` checks and sets ponzu-api's settings and
creates nothing, and `vercel-env` and `secrets generate` take `--env` and write production's
entries with the Production target only and dev's with dev's id only, refusing to write an entry
that would cover both.

## Applying the desired state

`bun scripts/prod/apply.ts <area> --env dev|production [--yes]` makes one area of an
environment what `infra/` says.

- Without `--yes` it only reads (GETs, mostly through the check's own readers), then prints
  what already matches, what it cannot do (a founder step or a dashboard setting), and each
  change as the exact request it would send: method, URL and body. Nothing is changed.
- With `--yes` it sends those requests in order and stops at the first that fails. Then it
  reads the area again and prints the check's lines for it. It exits 0 only when every one of
  them is `ok`.
- Credentials come from the environment, with the same names as the check's, but with write
  access. A missing one stops the area before anything is read. Every printed line goes
  through the redactor, and a vendor's refusal prints only its status, never its body.
- Agents run it only without `--yes`. Applying to production is the founder's.

| Area | What it does | Needs |
|---|---|---|
| `vercel-project` | Creates the project when it is missing (`apps/api`, `hono`, `iad1`, OIDC with the team issuer, Standard Protection, no Git, no variables), then sets the Node version. On an existing project it updates only the settings that differ. A connected Git repository is a note: disconnect it in the dashboard. | `VERCEL_TOKEN` |
| `vercel-env` | Adds the public values `environments.json` holds to the Production target as `plain` variables: `PONZU_ENVIRONMENT`, `PONZU_API_URL`, `WORKOS_CLIENT_ID`, `GITHUB_APP_SLUG`, `NEON_REALTIME_URL`, `PONZU_ASSETS_URL`, `R2_BUCKET`, `R2_PRIVATE_BUCKET`, `PONZU_POSTHOG_HOST`, `PONZU_POSTHOG_AI_CONTENT`, `PONZU_MIN_CLIENT_VERSIONS`. A plain value that differs is changed. A value stored as sensitive or encrypted cannot be read back, so it is left alone and named, and the read after `--yes` reports it as `manual` rather than `ok`. A `null` in infra is skipped. It never writes the Preview target, and it refuses `--env dev`: dev shares ponzu-api with production, and its values belong to the `dev` custom environment, which apply does not write yet, so they would land on the Production target. | `VERCEL_TOKEN` |
| `secrets generate --names PONZU_VAULT_KEY,CRON_SECRET` | Makes 32 random bytes (base64url) for each name that is not set yet and stores it on the Production target as `sensitive`. The value exists only in memory, is sent once, and is never printed or written to disk. A name that is already set is never replaced (rotation is below), and no other name is accepted. It refuses `--env dev` for the same reason as `vercel-env`. | `VERCEL_TOKEN` |
| `firewall` | When the live firewall differs from `infra/vercel-firewall.json`, one `PUT /v1/security/firewall/config` with the file as its body. A PUT replaces the whole configuration, so IP blocks someone set in the dashboard, which the file does not describe, are read and sent back unchanged. | `VERCEL_TOKEN` |
| `neon` | Where `infra/neon.json` asks (production): the read-write compute (`suspend_timeout_seconds`, autoscaling), the project's history retention, the branch's backup schedule and its protection, each only when it differs. Realtime is a note: the founder turns it on (D3). | `NEON_API_KEY`, `NEON_PROJECT_ID` |
| `r2` | The assets bucket's CORS and lifecycle, each replaced with its file when it differs. Replacing the lifecycle also removes any live rule that would delete under `private/`. Buckets, domains and r2.dev are the founder's (D4). | `CLOUDFLARE_API_TOKEN` (R2 write), `CLOUDFLARE_ACCOUNT_ID` |
| `cloudflare-headers` | The response header rule on the environment's assets host, in the zone's `http_response_headers_transform` phase. The phase is written whole, so every other rule in it is sent back unchanged; a rule already on the host is replaced in place, keeping its id. | `CLOUDFLARE_API_TOKEN` (Zone Read, Transform Rules Edit) |
| `posthog` | When any of the four settings in `infra/posthog.json` differs, one `PATCH /api/projects/{id}/` with all four. | `POSTHOG_PERSONAL_API_KEY` (`project:write`) |
| `github-rulesets` | Each `infra/github/ruleset-*.json`, found by name: created when missing, replaced by id when it differs. It belongs to the repository, so `--env` may be left out. | `GH_TOKEN` or `GITHUB_TOKEN`, as an admin |

Two things it does differently from the obvious route, and why:

- **The firewall's PUT is a plain request, not `@vercel/sdk`'s `security.putFirewallConfig`.**
  On 1.28.53 that method's request schema declares `managedRules` as an empty object, so it
  strips `bot_protection` and `ai_bots` before sending. A test pins this, so it fails when the
  SDK is fixed and the area can move back to it. The URL, query and body are the ones the SDK
  would send.
- **PostHog has no official SDK for its management API**, so its PATCH is a plain request, as
  the check's read is.

Not proven yet:

- No write has gone to any vendor. Every area is tested against fakes: for each, the dry run's
  bodies are asserted exactly, and `--yes` must send exactly what the dry run printed.
- Live dry runs, which are read-only, have run on dev for `neon` (nothing to change) and
  `github-rulesets` (`Protect main` matches its file; `Protect cloud` would be created).
- That `filterProjectEnvs` returns a `plain` variable's value without being asked to decrypt.
  If it does not, `vercel-env` would propose editing a value that is already right; the read
  after `--yes` would still show the truth.
- That PostHog still accepts the four settings on `/api/projects/{id}/`, rather than only on
  `/api/environments/{id}/`. If it ignores them, the read after `--yes` fails and says so.
- That Vercel applies a firewall `PUT` at once, rather than as a draft. The read after `--yes`
  would fail if it does not.

## Uptime

`.github/workflows/uptime.yml` runs `bun scripts/ci/uptime.ts` every five minutes. GitHub runs a
schedule only from the default branch, `main`, and a dispatch from any other branch checks
nothing.

- Each run asks production's `/v1/health` up to three times, 15 seconds apart. Production is up
  when one answer is a 200 with `status` ok, `database` true, `environment` production and a
  `cron.lastRanAt` under five minutes old: a minute that stopped is down, though every request
  still answers. `lastRanAt` null (the minute has never run on production's database) is down
  too: right after the first production deploy it lasts a minute or two, and the rule below
  that one failing run opens nothing is the grace for it. Counted as up, it would hide for good a
  schedule whose every run is refused, which records nothing. An answer with no `cron` at all
  is not judged on the minute: it is an API deployed before health reported it, which is what
  production serves until its first deploy after this rule reached `main`. The
  commit, image and migration count are the deploy's own check, not this one, because a merged
  commit waits for the founder's approval before it deploys.
- A run that finds production down fails. The next run reads that conclusion back from the
  Actions API, so the second failing run in a row opens one issue labelled `production-down`
  (the label is made the first time it is needed). A single failing run opens nothing.
- While production stays down, each run rewrites that issue's body with the count, when it
  started and the last problem, rather than commenting, so a long outage is one notification.
- The first run that finds production up comments on the issue and closes it.
- A run that fails for another reason (GitHub's API, for one) also counts as a failure for the
  next run, so the issue can open after one real failure instead of two. That errs towards
  telling someone.

There is no paid status vendor. The site's status page reads `/v1/health` itself.

## Release holds

Release Please opens a release pull request per app, and release.yml's auto-merge job turns on
auto-merge for it after asking `bun scripts/release-hold.ts --app <ponzu|mobile> --title
"<title>" --proposed <the PR's manifest>`. It holds the PR, which a person then merges, when:

- the repository variable `RELEASES_HELD` (comma-separated, for example `ponzu,mobile`) names
  the app, or names anything that is not an app, so a typo holds everything;
- the version is a major bump over main's `.release-please-manifest.json`, so `2.0.0` is never
  merged by itself;
- the title is not exactly `chore(main): release X.Y.Z` (or `release mobile X.Y.Z`), the PR's
  own manifest gives another version, or the version is not newer than the one released now.

A held PR also loses auto-merge it already had, so a `1.81.0` PR that a later `feat!:` turns
into `2.0.0` stops waiting to merge on the next push to `main`. The run writes a notice saying
why. The job fails closed: it runs even when Release Please failed part way, one app's run never
cancels the other's, and when the hold cannot be decided (the script or a GitHub call fails) its
last step turns off any auto-merge the release PR already had. To release a held PR, merge it by hand; to stop holding an app, take it out of
`RELEASES_HELD`.

## Rotating secrets

| Secret | How |
|---|---|
| `PONZU_VAULT_KEY` | Set the new key and move the old one to `PONZU_VAULT_OLD_KEYS`; deploy; once that deployment serves every request, run `bun apps/api/scripts/reseal.ts` with its `DATABASE_URL`, `PONZU_VAULT_KEY` and `PONZU_VAULT_OLD_KEYS` until it reports nothing left behind (the selfcheck's `vault_old_keys` reads 0); then drop the old key and deploy. |
| `GITHUB_APP_PRIVATE_KEY` | Add a second key on GitHub, set it, deploy, delete the old one on GitHub. |
| `GITHUB_WEBHOOK_SECRET` | Set the new value, then `bun apps/api/scripts/github-webhook.ts configure --env <dev\|production>`, then `redeliver` once the deploy is live (apps/api/README.md, "Deploying"). |
| `CRON_SECRET` | Set it in that environment and deploy that environment. The schedule sends the value of the deployment that is current in its environment, so the new one is sent only once that deploy is current ([Handling scheduled runs](https://vercel.com/docs/schedules/handle-runs)). |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Create the new token, set, deploy, revoke the old. |
| `DATABASE_URL` | Reset the role's password in Neon, set, deploy. |
| `NEON_REALTIME_SECRET` | Rotate in Neon, set, deploy; renewals reseal within a minute. |
| `WORKOS_API_KEY`, `PONZU_ANTHROPIC_API_KEY`, `EXPO_ACCESS_TOKEN` | Create the new one, set, deploy, revoke the old. |
| `RELEASE_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TOKEN_PRODUCTION`, the Apple certificate | Before they expire; the check warns 30 days ahead for `RELEASE_TOKEN`. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Add a new bypass in Vercel › ponzu-api › Settings › Deployment Protection, put it in the `production` environment, then revoke the old one. Revoke it at once if it may have leaked: it opens every deployment of the project. |

## Backups and restore

- Neon keeps 7 days of point-in-time history, a daily snapshot kept 35 days, and a snapshot
  before every production migration, kept 14 days.
- R2 has no versioning. Its objects are re-creatable previews or checkpoints; the database is the
  system of record.
- `bun scripts/prod/restore-drill.ts --env dev|production [--hours-ago <n>]` leaves the live
  database alone. With `NEON_API_KEY` and `NEON_PROJECT_ID`, it branches
  `restore-drill-<env>-<time>` from the environment's branch as it was an hour ago (the branch
  expires by itself after a day, in case the run is killed), counts the rows of every table on
  both branches (counts only, never a row), deletes the drill branch and lists the branches
  again. A table passes when its two counts are within the larger of 100 rows and a quarter of
  its live rows; a table only one side has passes only when the live branch has more
  migrations recorded than the restore, so a restore with no tables at all fails. It exits 0 only when every table passes and the branch list is as it
  was. The orchestrator runs it on dev; the founder runs it monthly on production. It has not
  yet run against Neon: its tests use a fake Neon, and its row counter was run once on a local
  Postgres.
- A real restore, only for a data catastrophe and only after checking with the founder: restore
  from the pre-migration snapshot with `finalize_restore: false` first, look, then finalize.
- Migrations are expand-only (no drop, rename, type change or new NOT NULL on existing data), so
  an older API deployment runs on a newer schema and Vercel's instant rollback is safe, with one
  exception. `0025_canvases` is a rename: it gives tables, columns, keys and indexes their canvas
  names. It runs only with every sandbox asleep, paired with the deploy of the API that reads the
  new names. An API deployed before it fails on the renamed schema, so never use Vercel's
  instant rollback across it: going back past 0025 means restoring the Neon database from the
  restore point (a branch) taken just before it, together with the deploy of that time. On dev
  that branch is the only way back: dev is a child branch, and Neon's point-in-time restore works
  only on root branches. So it is taken last, with every sandbox asleep and no job waiting,
  immediately before the migration, and its operations are finished before the migration starts.

## Spend

Every alert lives in a vendor's dashboard, so the check lists each as `manual: confirm`:

- Vercel Spend Management: an alert, then a pause.
- The Neon plan's billing alert.
- Cloudflare billing notifications.
- The Anthropic workspace's monthly limit.
- PostHog billing limits, for each product.

An awake sandbox costs about $0.11 to $0.16 an hour on Vercel Sandbox Pro rates in iad1 and is
billed at 5 credits ($0.50). Until billing enforces its cap, the per-workspace (5) and per-owner
(3) sandbox caps bound how many run at once but not for how long: one owner holding three awake
all month costs about $280. So before launch either billing's cap is enforced, or the founder
accepts the caps plus Spend Management's pause plus the maintenance switch
(`PONZU_MAINTENANCE`, built with the API's production work).

**What a spend pause stops, with dev and production in one project.** Spend Management's pause
is team-wide and "Pausing only affects production deployments"
([Spend Management](https://vercel.com/docs/spend-management)). So a pause takes
`api.ponzu.design` down and stops production's deployments, while `api-dev.ponzu.design` keeps
serving and keeps waking sandboxes. "When a project is paused, Vercel skips its scheduled runs"
([Managing Schedules](https://vercel.com/docs/schedules/manage)); production's minute certainly
stops, and whether dev's does too is not documented. If it does, dev keeps waking sandboxes with
nothing putting them to sleep but their session timeout. So:

- Never pause the project by hand to stop dev's spend: that stops production and its minute.
- Dev's brakes are its own: the per-workspace and per-owner sandbox caps in code, the sandbox
  session timeout, and `PONZU_MAINTENANCE=wakes_paused` set on the `dev` environment followed by
  a redeploy of dev.
- Point the Spend Management webhook at an alert that tells the orchestrator to set that switch
  on dev, rather than relying on the pause to cover dev.

## Env and secrets

Every entry on ponzu-api names the environments it covers, and **no entry covers the Production
target and any other environment** (Preview, Development or `dev`): one entry is one value, so a
shared entry would be a shared secret. Once the Production target holds no dev value, the team
policy Separate Production Secret Values makes Vercel refuse such an entry for a Secret (founder
step D10; whether it is on is the founder's to confirm).

ponzu-api, Production target, typed or written there only:

- Secrets: `DATABASE_URL` (the default branch, pooled), `WORKOS_API_KEY`,
  `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `CRON_SECRET`,
  `PONZU_VAULT_KEY` (new, never dev's), `NEON_REALTIME_SECRET`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `PONZU_ANTHROPIC_API_KEY`, and the keys later features add
  (`EXPO_ACCESS_TOKEN`, `PONZU_POSTHOG_PERSONAL_API_KEY`, Stripe's, `RESEND_API_KEY`).
- Public: `PONZU_ENVIRONMENT=production`, `PONZU_API_URL=https://api.ponzu.design`,
  `WORKOS_CLIENT_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG=ponzu-cloud`, `GITHUB_APP_BOT_USER_ID`,
  `NEON_REALTIME_URL`, `PONZU_ASSETS_URL=https://assets.ponzu.cloud`, `R2_ACCOUNT_ID`,
  `R2_BUCKET=ponzu-assets`, `R2_PRIVATE_BUCKET=ponzu-private`, `PONZU_POSTHOG_KEY`,
  `PONZU_POSTHOG_HOST`, `PONZU_POSTHOG_AI_CONTENT=0`,
  `PONZU_MIN_CLIENT_VERSIONS=macos=2.0.0,windows=2.0.0,linux=2.0.0`, and the sandbox limits at
  their defaults.

ponzu-api, `dev` environment: 27 names, the 21 `REQUIRED_ENV` asks for and some optional ones
(`EXPO_ACCESS_TOKEN` and PostHog's among them), with its own `PONZU_ENVIRONMENT=dev` and
`PONZU_API_URL=https://api-dev.ponzu.design`. None of them covers the Production target any
more: the orchestrator took Production off each on 12 Nov 2026 without re-entering a value.

ponzu-api, Preview target: dev's values, with `PONZU_ENVIRONMENT=preview` and
`PONZU_API_URL=https://api-dev.ponzu.design`, and never a production value.

Forbidden in every environment: `VERCEL_TOKEN`, `BOAT_API_KEY`, `PONZU_SANDBOX_SNAPSHOT`.

The GitHub environment `production` holds `VERCEL_TOKEN_PRODUCTION`,
`VERCEL_AUTOMATION_BYPASS_SECRET` and `NEON_API_KEY`; the environment `dev` holds dev's
`VERCEL_TOKEN`. Both deploy jobs name the one project with `VERCEL_API_PROJECT_ID`. New
repository variables: `API_DEPLOY_PRODUCTION` and `RELEASES_HELD`.

The check and apply scripts read their credentials from the environment of whoever runs them and
never store them.
