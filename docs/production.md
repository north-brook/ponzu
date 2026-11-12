# Production

How Ponzu Cloud runs in production: every resource and what is right for it, the order in
which the founder creates them, how each secret is rotated, how the data is backed up and
restored, and what bounds the bill. The specification is [cloud.md](cloud.md); this page is the
runbook behind its "Environments" section.

**What exists today, and what does not.** The desired state in [`infra/`](../infra) and its
reader, [`scripts/prod/desired.ts`](../scripts/prod/desired.ts), are built and tested. The
scripts this page names for checking and applying that state (`scripts/prod/check.ts`,
`apply.ts`, `github-app.ts`, `restore-drill.ts`), the API's `/v1/cron/selfcheck` and the
production deploy job are later pieces of work. (The API's `PONZU_ENVIRONMENT` variable and
the environment, image, bundle and migration counts in `/v1/health` are built.) Each is
marked *(not built yet)* where it first appears, and nothing in production exists until the
founder's steps below create it.

## Two environments

| | Dev | Production |
|---|---|---|
| Vercel project | `ponzu-api` (exists) | `ponzu-api-prod` (to be created) |
| API | `api.ponzu.design` until three days before cutover, then `api-dev.ponzu.design` | `api.ponzu.design` from two days before cutover |
| Database | Neon branch `dev` | the Neon project's default branch, starting empty |
| Auth | WorkOS staging | WorkOS production |
| GitHub App | `ponzu-dev` | `ponzu` |
| Files | `assets-dev.ponzu.cloud` | `assets.ponzu.cloud` (bucket `ponzu-assets`), plus `ponzu-private` for checkpoints |
| Analytics | PostHog "Ponzu Dev" (728454) | PostHog "Ponzu" (to be created) |
| Deploys | from `cloud`, by the deploy workflow or the orchestrator | from `main` only, through the GitHub Environment `production`, which the founder approves |

Production gets a Vercel project of its own because Vercel runs crons only on a project's
Production target, and the sandbox sweep and the job retries run on the minute cron. Dev kept as
a Preview of one shared project would never sleep a sandbox or retry a wake. Two projects also
keep the environments apart by more than a name: separate OIDC tokens, env, registry, spend and
firewall. Each still names its sandboxes by its database's scope, as a second wall.

The sandbox image is built once, into dev's registry, and the production deploy copies it by
digest (`docker buildx imagetools create`), so production runs exactly the bytes dev checked.

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
| `posthog.json` | Project settings both PostHog projects must have |

The rules of `environments.json`:

- `null` means **not created yet**. Anything that reads the file shows it as `pending`, with
  the founder step that creates it, and never as a pass.
- `false` means **absent on purpose**: dev has no private bucket (its checkpoints sit in the
  assets bucket) and no minimum client versions.
- `neonBranch: "@default"` is the Neon project's default branch, whatever it is called.
- `release` stays `"dev"` until the cutover PR flips it to `"production"`, so every PR's
  packaged build keeps working until then.

Two commands read it:

```sh
bun scripts/prod/desired.ts status production          # every field: ok, none or pending
bun scripts/prod/desired.ts assert-release production  # exit 1 unless release is production and nothing is pending
```

`assert-release production` exits 1 today, naming `release`, the three production fields the
founder's steps fill (WorkOS's client id, the Realtime URL, the PostHog project id), and
`api.ponzu.design`, which both environments still name. It also fails when any production value
that says where to connect (the API, WorkOS, Realtime, assets, the GitHub App, the Vercel
project, the Neon branch, a bucket, the PostHog project) is the same as dev's, so dev's `apiUrl`
and `apiDomains` must move to `api-dev.ponzu.design` (founder step D11) before it can pass.
Production's `r2.private` may be `null` until the bucket exists, but never `false`. The release
workflow runs it, from the tag being released, before it publishes ("The release talks to
production" in release.yml), so no release can ship pointing at dev. A dry run publishes
nothing and is not held by it.

The desktop build reads the same file (`apps/desktop/scripts/build.ts`): a release bakes the
environment `release` names and Ponzu Dev bakes dev's, and a `null` among the fields the app
uses (`apiUrl`, `workosClientId`, `realtimeUrl`, `assetsUrl`) fails the build.

## Every resource, and what is right

### Vercel `ponzu-api-prod`

Created by `bun scripts/prod/apply.ts vercel-project --env production --yes` *(not built yet)*.

| Setting | Value |
|---|---|
| Project | root `apps/api`, framework `hono`, function region `iad1`, Node as `engines.node` says |
| Git | not connected |
| OIDC | issuer mode team |
| Protection | Standard Deployment Protection on |
| Env, Production target | the list under [Env and secrets](#env-and-secrets) |
| Env, Preview target | **empty**, so a preview of the production project fails at boot |
| Forbidden env names | `VERCEL_TOKEN`, `BOAT_API_KEY`, `PONZU_SANDBOX_SNAPSHOT` |
| Domain | `api.ponzu.design` |
| Container Registry | `ponzu-runner`, holding `apps/runner/image/current.json`'s digest |
| Firewall | `infra/vercel-firewall.json` |
| Spend Management | an alert, then a pause; the amounts are the founder's |

### Vercel `ponzu-api` (dev)

As now, plus `PONZU_ENVIRONMENT=dev`, an explicit `PONZU_API_URL`, the domain
`api-dev.ponzu.design`, and `BOAT_API_KEY` removed after cutover.

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
`apps/api/scripts/neon.ts` refuses the default branch, and the production deploy job will be the
only thing that sets the guard that lets it through.

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

Created from a manifest by `bun scripts/prod/github-app.ts create --env production
--workos-callback <url>` *(not built yet)*, which the founder runs and confirms on GitHub's page.

- Public, with the same permissions and events as `ponzu-dev`.
- Webhook `https://api.ponzu.design/v1/github/webhook`, JSON, SSL verification on.
- Setup URL `https://api.ponzu.design/v1/github/setup`, with `setup_on_update`.
- Callback URL: WorkOS production's GitHub callback. `request_oauth_on_install` off.
- Its client secret, private key and webhook secret go straight into ponzu-api-prod's env as
  sensitive values; the script prints only the slug, the App id and the client id.

`api.github.com/apps/ponzu` answered 404 when this was written, so the slug is free or held by a
private App. If GitHub refuses the name, the App takes another slug, and `environments.json`
and `GITHUB_APP_SLUG` take it too.

### WorkOS production

- GitHub OAuth uses the `ponzu` App's client id and secret, so tokens are 8-hour App user tokens.
- Redirect URIs `http://127.0.0.1/auth/callback` (any port) and `ponzu://auth/callback`.
- Every sign-in method but GitHub off; default emails off.

The check cannot read WorkOS's configuration, so it proves it instead: it builds an authorize
URL for each redirect URI and requires a redirect to GitHub carrying the production App's client
id. WorkOS answers a redirect URI it does not allow with an error page, not a redirect.

### PostHog "Ponzu"

Session recording, exception autocapture, console logs and heatmaps on (`infra/posthog.json`).
The group type `workspace` exists once the first event has come in; it cannot be made ahead.
Replay is `private` and AI content is off unless the founder chooses otherwise (founder step A4).

### Anthropic

A workspace "Ponzu production" with a monthly spend limit, and a key used only as
`PONZU_ANTHROPIC_API_KEY` for ideas and their gate.

### The GitHub repository

- `main` keeps its ruleset exactly as it is: `infra/github/ruleset-main.json` is a copy of it,
  and a test compares the two field by field against a read-only recording.
- `cloud` gets a ruleset requiring "Conventional commit messages", "Check, typecheck, test",
  "Database on Postgres" and "Desktop package". A test checks each is a job name in `ci.yml`.
  It also requires a pull request, squash-merged, with no approval needed (as `main`'s does),
  and it has no bypass. Once it is applied nothing reaches `cloud` by a direct push, a revert
  included: a revert goes through a pull request like any other change.
- The environment `production`: the founder is the required reviewer, only `main` may deploy,
  and it holds `VERCEL_TOKEN` (for ponzu-api-prod) and `NEON_API_KEY`.
- The environment `release-signing`, as now.
- `infra/github/repo.json` names every variable and secret the workflows read; a test fails
  when a workflow reads one it does not name.

## The founder's steps

These are section D of the program's founder list, in order. Each turns on something already
built and tested, and none blocks a merge. Paste secrets only into the vendor's dashboard or
Vercel's env, marked sensitive, never into chat or a file in the repository.

Two dev steps come first, whenever convenient:

- **B1. The dev domain, early.** Vercel › ponzu-api › Settings › Domains: add
  `api-dev.ponzu.design`, with the CNAME Vercel shows. Change no env yet. Tell the orchestrator
  when `https://api-dev.ponzu.design/v1/health` answers.
- **B6. The dev bucket.** R2 › the dev assets bucket › Lifecycle: delete objects under
  `staging/` after a day, and abort incomplete multipart uploads after a day. Add no rule on
  `private/`. Optionally, the header rule on `assets-dev.ponzu.cloud`.

Then production, when the program reports it is ready:

1. **D1. Plans.** Vercel Pro. A Neon plan that allows scale-to-zero off and backup schedules
   (Launch or Scale). R2 billing on.
2. **D2. Vercel.** Create a team token able to manage ponzu-api-prod, then run
   `bun scripts/prod/apply.ts vercel-project --env production --yes`. Confirm Standard
   Protection and OIDC (team issuer) are on. Set Spend Management: an alert amount, then a pause
   amount.
3. **D3. Neon.** Enable Realtime on the default branch. Run
   `bun scripts/prod/apply.ts neon --env production --yes`. Send the orchestrator the Realtime
   URL; it is public and goes in `environments.json`.
4. **D4. Cloudflare.** Create buckets `ponzu-assets` and `ponzu-private` (ENAM). Attach
   `assets.ponzu.cloud` to ponzu-assets and turn r2.dev off. Create an R2 token scoped to those
   two buckets (Object Read and Write) as an Account API token, so the check can see its scope,
   and a read-only Cloudflare token for the check (permissions under "Checking production"). Run
   `bun scripts/prod/apply.ts r2 --env production --yes` and
   `bun scripts/prod/apply.ts cloudflare-headers --env production --yes`.
5. **D5. WorkOS production.** Activate it, and copy the GitHub OAuth callback URL from
   Authentication › GitHub.
6. **D6. The GitHub App.** Run `bun scripts/prod/github-app.ts create --env production
   --workos-callback <the URL from D5>` and click Create on GitHub's page. Upload the logo.
   Install the App on north-brook/ponzu-test for the end-to-end run.
7. **D7. WorkOS production, continued.** Give GitHub OAuth the App's client id (printed by D6)
   and client secret (in the temporary file D6 names; press Enter afterwards to delete it). Add
   the redirect URIs `http://127.0.0.1/auth/callback` and `ponzu://auth/callback`; if the custom
   scheme is refused, tell the orchestrator. Turn off every method but GitHub, and default
   emails. Create an API key and add it to ponzu-api-prod as sensitive `WORKOS_API_KEY`. Send
   the orchestrator the client id.
8. **D8. PostHog.** Free one project slot in the organisation (it is at its limit of six) and
   create the project "Ponzu". Run `bun scripts/prod/apply.ts posthog --env production --yes`
   and turn on cookieless tracking. Create a personal key with `person:write` for it, and a
   source-map key. Send the orchestrator the project id.
9. **D9. Anthropic.** Create the workspace "Ponzu production" with a spend limit, and a key. Add
   it to ponzu-api-prod as sensitive `PONZU_ANTHROPIC_API_KEY`.
10. **D10. Secrets and env.** Run `bun scripts/prod/apply.ts secrets generate --names
    PONZU_VAULT_KEY,CRON_SECRET --env production --yes`, which writes 32 random bytes each
    straight to Vercel and prints nothing. Add as sensitive: `DATABASE_URL` (the default
    branch's pooled URL), `NEON_REALTIME_SECRET`, the R2 keys from D4, `EXPO_ACCESS_TOKEN` (a
    production token), `PONZU_POSTHOG_PERSONAL_API_KEY`, and `RESEND_API_KEY` if email is used.
    Run `bun scripts/prod/apply.ts vercel-env --env production --yes` for the public values.
    Leave the Preview target empty.
11. **D11. Domains.** Three days before cutover, tell the orchestrator: it sets dev's
    `PONZU_API_URL=https://api-dev.ponzu.design`, redeploys dev, rebuilds Ponzu Dev and moves
    dev's `apiUrl` in `environments.json`; then point the ponzu-dev App's webhook and setup URLs
    at api-dev. Two days before, move `api.ponzu.design` from ponzu-api to ponzu-api-prod. A dev
    sandbox awake across the switch keeps the old address only until its session ends, at most
    a day, hence three days.
12. **D12. The GitHub repository.** Create the environment `production` with yourself as
    required reviewer, holding the secrets `VERCEL_TOKEN` (for ponzu-api-prod) and
    `NEON_API_KEY`. Add the variables `VERCEL_API_PROD_PROJECT_ID` and
    `API_DEPLOY_PRODUCTION=true`, repoint the `PONZU_APP_POSTHOG_*` variables and the secret
    `PONZU_APP_POSTHOG_CLI_API_KEY` to the new project, and add the Container Registry OIDC policy
    on ponzu-api-prod for north-brook/ponzu. Run `bun scripts/prod/apply.ts github-rulesets
    --yes`. Check that `RELEASE_TOKEN` expires after the cutover.
13. **D13. Releases and stores.** Set the repository variable `RELEASES_HELD=ponzu,mobile`.
    Check the Developer ID certificate's expiry. Set the EAS production env (the production API
    URL, WorkOS production's client id, the production PostHog key).
14. **D14. Stripe live.** Activate live mode, repeat the test-mode setup with live keys and a
    webhook on `https://api.ponzu.design/v1/stripe/webhook` onto ponzu-api-prod, and set
    `PONZU_BILLING=on` there only after counsel and tax are settled.
15. **D15. The first production deploy.** Approve it in Actions: it snapshots, migrates the empty
    database, copies the image and deploys. Then run
    `bun scripts/prod/check.ts --env production --deep` until every line is `ok` or `manual`, and
    confirm each manual spend line. Sign in once against production on an account whose Claude
    is the dev key, and give the orchestrator the session file's path for the end-to-end run.

After D3, D7 and D8, the orchestrator fills `environments.json`'s production nulls in one PR;
the cutover PR flips `release` to `"production"`, and `assert-release production` must then
exit 0. Cutover day itself, and how to go back, are in docs/cutover.md, written with the cutover
work.

Monthly, after cutover: `bun scripts/prod/restore-drill.ts --env production`.

## Checking production

`bun scripts/prod/check.ts --env dev|production [--json] [--deep]` is read-only and never asks
a vendor to decrypt a value.

- It reads credentials from the environment of whoever runs it: `VERCEL_TOKEN` (and
  `VERCEL_TEAM_ID`, optional for the read-only lines; without it the team is named by its public
  slug), `NEON_API_KEY` with `NEON_PROJECT_ID`, `CLOUDFLARE_API_TOKEN` (read only) with
  `CLOUDFLARE_ACCOUNT_ID` (R2's account id), `POSTHOG_PERSONAL_API_KEY` (read only), `GH_TOKEN`
  or `gh` auth, and `CRON_SECRET` for the selfcheck. A missing credential makes its section
  `skipped`, never a pass.
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

What each section checks today (GitHub, WorkOS and PostHog come with the next pieces of this
work):

| Section | Lines |
|---|---|
| `vercel` | The project exists (on production, `pending` until D2); root `apps/api`, the API's Node version, region `iad1`, no Git connection; OIDC with the team issuer; Standard Deployment Protection; the Production target holds every name `REQUIRED_ENV` lists and only names the API reads; no `FORBIDDEN_ENV` name on any target; on production, the Preview and Development targets are empty and every secret is stored as sensitive; the environment's API domains are verified on the project (on production, `pending` while dev still lists the domain, before D11); the live firewall equals `infra/vercel-firewall.json` (enabled, OWASP categories, managed rules, and each rule's conditions, action and limits); the latest production deployment is ready and carries `vercel.json`'s cron. |
| `neon` | The environment's branch exists (dev's is not the default branch); Realtime is on at `environments.json`'s `realtimeUrl` (on production, `pending` until D3 sends it). Where `infra/neon.json` asks (production): the read-write compute never sleeps (`-1`) and scales 0.5 to 2 CU; point-in-time history keeps at least 7 days; the backup schedule is daily at 07:00 UTC kept 35 days, and the latest snapshot is under 26 hours old (no schedule is `pending`, never a pass); the branch is protected. |
| `cloudflare` | The assets bucket exists (production's in ENAM), is served at the environment's assets host with an active certificate and at no other custom domain, has r2.dev off, has `infra/r2/cors.json`'s CORS exactly, and has `infra/r2/lifecycle.json`'s rules (none of them live is `pending`). A live lifecycle rule that would delete under `private/` fails, whatever the file says. Production's private bucket exists in ENAM with no domain, r2.dev off and no delete rule. An account API token reaches exactly the environment's buckets and no other (on dev, a token the account listing cannot show is `manual`). The transform rule on the assets host sets the headers `infra/cloudflare/assets-headers.json` names (dev may go without). |
| `api` | `/v1/health` answers as this environment, `ok`, with its database; applied migrations equal the build's; the image is current.json's; on production the commit is `main`'s head. Then each `/v1/cron/selfcheck` id is `ok`. The cron secret is sent only after health has said it is this environment, so dev's secret never reaches production. While `api.ponzu.design` is in both environments' `apiDomains` (before D11), production's line is `pending`. |
| `dns` | Each of the environment's API domains, the assets host and `ponzu.design`: resolves over DNS-over-HTTPS, presents a valid certificate with at least 14 days left, and answers as it should (the API and the site from Vercel; the assets host with the header rule, which dev may go without). A production name not set up yet is `pending` with its founder step. |
| `spend` | The five spend alerts, each `manual`. |
| `deep` | With `--deep` only: the throwaway sandbox is made from current.json's image and removed. |

The Vercel section reads through `@vercel/sdk`. On 1.28.53 the SDK's own schema refuses dev's real
project answer (it requires a `traffic_sources` field the API does not send), so the check falls
back to the answer the SDK hands over with its validation error. The tests run that path on the
recorded answers (trimmed to the fields the check reads, which the SDK refuses too); the full
answer went through it once when it was recorded.

## Rotating secrets

| Secret | How |
|---|---|
| `PONZU_VAULT_KEY` | Set the new key and move the old one to `PONZU_VAULT_OLD_KEYS`; deploy; once that deployment serves every request, run `bun apps/api/scripts/reseal.ts` with its `DATABASE_URL`, `PONZU_VAULT_KEY` and `PONZU_VAULT_OLD_KEYS` until it reports nothing left behind (the selfcheck's `vault_old_keys` reads 0); then drop the old key and deploy. |
| `GITHUB_APP_PRIVATE_KEY` | Add a second key on GitHub, set it, deploy, delete the old one on GitHub. |
| `GITHUB_WEBHOOK_SECRET` | Set the new value, then `bun scripts/github-webhook.ts configure`, then `redeliver` once the deploy is live (apps/api/README.md, "Deploying"). |
| `CRON_SECRET` | Set and deploy; Vercel sends the new one at once. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Create the new token, set, deploy, revoke the old. |
| `DATABASE_URL` | Reset the role's password in Neon, set, deploy. |
| `NEON_REALTIME_SECRET` | Rotate in Neon, set, deploy; renewals reseal within a minute. |
| `WORKOS_API_KEY`, `PONZU_ANTHROPIC_API_KEY`, `EXPO_ACCESS_TOKEN` | Create the new one, set, deploy, revoke the old. |
| `RELEASE_TOKEN`, `VERCEL_TOKEN`, the Apple certificate | Before they expire; the check warns 30 days ahead for `RELEASE_TOKEN`. |

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
  its live rows; a table only one side has passes only when the migrations table shows a
  migration in between. It exits 0 only when every table passes and the branch list is as it
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

## Env and secrets

ponzu-api-prod, Production target:

- Sensitive: `DATABASE_URL` (the default branch, pooled), `WORKOS_API_KEY`,
  `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `CRON_SECRET`,
  `PONZU_VAULT_KEY` (new, never dev's), `NEON_REALTIME_SECRET`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `PONZU_ANTHROPIC_API_KEY`, and the keys later features add
  (`EXPO_ACCESS_TOKEN`, `PONZU_POSTHOG_PERSONAL_API_KEY`, Stripe's, `RESEND_API_KEY`).
- Public: `PONZU_ENVIRONMENT=production`, `PONZU_API_URL=https://api.ponzu.design`,
  `WORKOS_CLIENT_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG=ponzu`, `GITHUB_APP_BOT_USER_ID`,
  `NEON_REALTIME_URL`, `PONZU_ASSETS_URL=https://assets.ponzu.cloud`, `R2_ACCOUNT_ID`,
  `R2_BUCKET=ponzu-assets`, `R2_PRIVATE_BUCKET=ponzu-private`, `PONZU_POSTHOG_KEY`,
  `PONZU_POSTHOG_HOST`, `PONZU_POSTHOG_AI_CONTENT=0`,
  `PONZU_MIN_CLIENT_VERSIONS=macos=2.0.0,windows=2.0.0,linux=2.0.0`, and the sandbox limits at
  their defaults.

ponzu-api-prod, Preview target: nothing. Forbidden on either target: `VERCEL_TOKEN`,
`BOAT_API_KEY`, `PONZU_SANDBOX_SNAPSHOT`.

ponzu-api (dev) adds `PONZU_ENVIRONMENT=dev` and an explicit `PONZU_API_URL`, set before the API
starts requiring them.

The GitHub environment `production` holds `VERCEL_TOKEN` (scoped to ponzu-api-prod) and
`NEON_API_KEY`. New repository variables: `VERCEL_API_PROD_PROJECT_ID`, `API_DEPLOY_PRODUCTION`
and `RELEASES_HELD`.

The check and apply scripts read their credentials from the environment of whoever runs them and
never store them.
