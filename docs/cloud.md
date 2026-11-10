# Ponzu Cloud

This is the architecture of the cloud rewrite. It is the contract the code on the
`cloud` branch is built against; where code and this file disagree, fix one of them
in the same pull request.

Ponzu stops being a local app. You sign in with GitHub, pick a repo, and describe a
design. A sandbox in the cloud checks the repo out and runs Claude Code on your own
Claude plan; Claude draws on the canvas, changes the code, and opens a pull request.
Everyone with access to the repo sees the same canvas and thread, live, on the Mac
and the iPhone.

There is no local runtime, no pairing, no outside agents, no importer and no
backwards compatibility with the 1.x app.

## Principles

1. **The database is the design.** Postgres holds every canvas, comment, thread and
   event. Nothing lives only in a sandbox or on a device.
2. **A sandbox is a cache.** It holds one design's checkout and one Claude session.
   Either can be rebuilt from GitHub and the database, so losing a sandbox loses
   nothing.
3. **Clients hold nothing durable.** No git, no agent, no secrets. A client can be
   wiped without losing work.
4. **The API is stateless.** Every request can land on a fresh function instance.
   Anything that must outlive a request is a row.
5. **One language for change.** `Doc`, `Op` and `applyOp` in `packages/core` are
   shared by the API, the clients and the sandbox. All of them apply the same ops
   to the same document in the same order.
6. **The sandbox is untrusted.** It runs a repo's code and an agent. It can act on
   one design and nothing else.

## Layout

```
apps/
  api/       HTTP API on Vercel (Hono, Node runtime, iad1). api.ponzu.design
  runner/    the process inside each sandbox: Claude Code, the canvas tools, Chromium
  desktop/   Electron shell: windows, sign-in, token storage, updater
  studio/    the app UI the desktop shell loads (and a browser app later)
  mobile/    Expo app for iPhone and iPad
  web/       marketing, download, privacy
packages/
  core/      Doc, Op, applyOp, validation, sanitizing, the sync replica
  canvas/    the canvas React components, shared by studio, the phone's canvas
             page and the marketing site
  tools/     the agent's canvas tools
  render/    headless Chromium: screenshots, layout, lint, recordings
  db/        Drizzle schema, migrations, queries
  sandbox/   sandbox provider interface; boat.dev is the one implementation
  client/    typed API client, live queries, the cloud canvas source
```

Deleted at cutover: `apps/cli`, `packages/server`, `packages/mcp`, `packages/store`,
`plugin/`, the marketplace manifests, and the `/gh`, `/local`, `/open`, `/share`
and badge routes in `apps/web`.

Where things run:

| | Runs | Holds |
|---|---|---|
| Clients | the person's device | a session token, a cache |
| API | Vercel functions | every credential, all authorization |
| Store | Neon Postgres, Cloudflare R2 | the system of record; R2 holds bytes |
| Sandbox | one boat.dev VM per design | a checkout and a Claude session |

## Identity and access

**Sign-in** is GitHub through WorkOS. Both apps run an authorization-code flow with
PKCE in the system browser, then post `{ code, code_verifier }` to
`POST /v1/auth/exchange`. The API exchanges it with WorkOS, stores the person's
GitHub user token encrypted, and returns WorkOS access and refresh tokens. The
GitHub token never reaches a device.

- The Mac app redirects to a loopback address (`http://127.0.0.1:<port>/auth/callback`).
- The iPhone app redirects to `ponzu://auth/callback` inside an auth session.
- Access tokens are five-minute JWTs. The API verifies them locally against
  WorkOS's JWKS. Clients refresh directly with WorkOS, one refresh in flight at a
  time, and always store the rotated refresh token.
- A verified token is not enough by itself. WorkOS is a public client: anyone can
  finish a sign-in with it directly and hold a well-signed token, without the
  exchange (and its check against GitHub) ever running. So the exchange records
  each session it lets in, and the API honors a token only for a recorded
  session. Signing out removes the record, which ends the session at the API at
  once and not five minutes later, whether or not WorkOS can be reached to
  revoke it there too.
- WorkOS will not finish a sign-in until the email is verified, and it does not
  take GitHub's word for it. The API completes that step itself during the
  exchange and then checks with GitHub that the address is verified there, so
  nobody is sent a code by email. Completing it vouches for the address to
  WorkOS, which joins accounts by email, so the API holds to three rules. It
  never completes the step for a WorkOS user who is already a Ponzu person:
  that is WorkOS about to attach a new identity to their user. When it has
  completed the step and then does not let the person in, it deletes the
  WorkOS user, so nothing stays verified or attached on its word alone. And
  WorkOS's own flag is never what lets someone in: GitHub is asked whenever the
  API completed the step, the first time a WorkOS user is let in, when their
  address has changed, and when the GitHub account is not the one that WorkOS
  user belongs to. One WorkOS user is one GitHub account, held by the database.
  A sign-in that fails after WorkOS has made a session revokes that session.
- Only a GitHub sign-in is taken. WorkOS can offer other methods; a session
  that came from one is refused and revoked.
- The GitHub user token lasts eight hours and its refresh token works once.
  The API refreshes it when it is about to run out, one refresh at a time per
  person: the claim is a column on the token's row, since function instances
  share nothing else.

**Workspaces.** A workspace is a GitHub account (a person or an organization) with
the Ponzu GitHub App installed. There is one row per account, not per installation:
the account's GitHub id is the workspace's identity, and the installation id is a
unique column on it that is empty while the App is not installed. Uninstalling and
installing again gives the account a new installation id and must come back to the
same workspace and its designs. A person's workspaces are the installations their
GitHub user token can reach (`GET /user/installations`).
The token does not reveal organizations the App is not installed on. Setup lists the
person's own account and the accounts where Ponzu is installed; any other
organization is added through GitHub's install page, which has its own picker.

**Membership** is GitHub's. Anyone who can reach an installation's repos is a
member; Ponzu stores only the role (Admin or Member). There are no invitations.

**Opening a design** needs read access to its repo. Steering it (messages, answers,
merging) needs write access. The API checks with
`GET /repos/{owner}/{repo}/collaborators/{login}/permission`, cached for a minute
and invalidated by membership webhooks.

**The GitHub App** is the only way Ponzu touches GitHub. The API mints one-hour
installation tokens scoped to one repository and the least permission a job needs.
The private key never leaves the API.

## The document and how it syncs

A design is a `Doc` (pages, artboards, node trees, tokens, comment threads, notes).
Every change is an `Op`. This does not change. What changes is who orders the ops:
the API does, in Postgres.

### Committing

```
POST /v1/designs/:id/ops     { ops: [{ id, op }] }
  → { committed: CommittedOp[], rejected: [{ id, reason }], seq }

CommittedOp = { seq, id, op, actor, at }
actor       = { kind: "user" | "agent", id, name, avatarUrl? }
```

The body is checked as a whole first (`validateCommit`): at most 64 ops, each
under a well-formed id that no other op in the post has. A body that fails is
refused whole with a 400, and nothing in it is committed.

Then for each op, in order, the API:

1. **Validates** it structurally (`validateOp`): a known variant, well-formed ids
   and names, sizes within `packages/core/src/limits.ts`, and no text Postgres
   can't hold (U+0000, half a surrogate pair). In a thread, event or question
   payload the same characters are replaced with U+FFFD instead, so tool output
   never fails a write.
2. **Sanitizes** node trees (`sanitizeOp`): blocked tags, `on*` attributes and
   `javascript:` URLs are removed. This used to happen only when HTML was parsed in
   the tool process, which is not enough once any client can post an op.
3. **Stamps** it (`stampOp`). The actor comes from the caller's token, never from
   the payload: a comment's author and every time in a thread op are the API's.
   Timestamps are carried in the op, so `applyOp` is deterministic and never reads
   the clock.
4. **Applies** it to the current document. An op that does not apply is rejected
   and the rest of the batch continues. A rejected op leaves the document exactly
   as it was, a `batch` op that failed partway included.
5. **Appends** it to `design_ops` with the next `seq` and bumps `designs.seq`, in
   one statement that only succeeds if `designs.seq` is still what the API read.
   On a miss it catches up and tries again.

`id` is generated by the sender and unique within a design. Posting the same id
again returns the original result, so a retry is safe, for seven days. An op is
kept in the log, and its id with it, for at least that long whatever has been
checkpointed since; after that it may be pruned, and the same id would be appended
as a new op. A sender must not retry an op older than that. `seq` counts a
design's ops from 1 with no gaps; a design nobody has changed is at 0.

### Reading

```
GET /v1/designs/:id/doc            → { doc, seq }
GET /v1/designs/:id/ops?after=N    → { ops: CommittedOp[], seq }   (410 if N is too old)
```

The API rebuilds the current document from the latest checkpoint plus the ops after
it, and caches it per function instance keyed by `(design, seq)`. It writes a new
checkpoint after every 64 ops or 256 KB of op payload.

### The replica

`Replica` in `packages/core` is the one implementation of the client side. The Mac
app, the phone and the sandbox all use it.

- It holds the document as of the last confirmed `seq`, plus a queue of pending ops.
- `apply(op)` applies locally at once and queues the op. Writes are optimistic:
  there is no waiting for an echo. It runs `validateOp` first, so an op the API
  would refuse on sight is never shown or queued, and returns the op's id.
- Pending ops are posted in order, one batch in flight. A post that fails is sent
  again with the same ids, after a wait that doubles from half a second to half a
  minute. Word from the API cuts the wait short, and so can the host (`retryNow`).
  The replica makes one request at a time, and takes turns between posting and
  catching up when both are due.
- A post carries at most 64 ops and 3 MB, which keeps the request and its answer
  inside the 4.5 MB a Vercel function takes. If the API refuses a post outright
  (too large, malformed), sending it again can't help: the replica sends its ops
  one to a post, and drops and reports the op that is refused alone.
- When committed ops arrive, the replica rolls back its pending ops, applies the
  committed ones in `seq` order, drops any pending op whose id was confirmed, and
  reapplies the rest. A pending op that no longer applies is dropped and reported,
  unless it was already posted: then the API's answer decides.
- A pending op that has waited seven days is dropped and reported the same way,
  not posted: the log may no longer remember its id (see Committing), so the
  replica cannot tell whether an earlier attempt landed.
- When it cannot continue from its own `seq` (a 410, a hole in what it fetched, a
  committed op that does not apply), it fetches the whole document and puts its
  pending ops back on top.
- The API says where the head is. Word of a `seq` the API turns out not to have
  is asked about once and then forgotten, and a whole document older than the
  replica's own is not taken.
- It emits each op with its actor so the canvas can animate what changed: once per
  op, and an op made here again only if the API committed it changed. That second
  time is marked as an echo, so nothing counts a person's own comment twice.

People only move and rename artboards, manage pages and write comments; agents edit
nodes. Conflicts are rare and the rule is simple: the committed order wins.

### Hearing about changes

Neon Realtime carries small rows only. A design's content never travels through it.

Clients watch the design's head row (`seq`, agent state, pull request state). When
`seq` moves, the replica fetches the ops after its own `seq` from the API. That is
one push of a few hundred bytes and one HTTP read, and it keeps large op payloads
away from Realtime's row-size limit.

### Undo

Undo is the API's: `POST /v1/designs/:id/undo` commits the inverse of the most
recent op by the caller or by the agent that has not been undone. `redo` reverses
it. Each op is stored with its inverse.

### Storage rules

- Node trees, ops and checkpoints are stored as `json`, never `jsonb`. `style` and
  `attrs` are ordered and `jsonb` reorders keys, which changes how CSS resolves.
- Node ids are not unique within a design. Nothing may key on them.
- Comment threads stay in the `Doc` and travel as thread ops, as today.

## Realtime

`packages/client` wraps Neon Realtime behind one module so it can be replaced.

- Clients never send SQL. They ask `POST /v1/live` for named queries with arguments
  (`workspace.designs`, `design.head`, `design.thread`, `design.presence`, `me`).
  The API authorizes each one and returns it sealed, with a 60-second lifetime.
- The endpoint takes a list, and clients renew all their subscriptions in one call.
- Live queries are plain filters and joins over small rows. Sorting happens on the
  client. Every watched table has a primary key.
- Presence is a row per person per open design, refreshed every 30 seconds and
  treated as gone after 75.

## The sandbox

One design owns one sandbox, one Claude session, one branch and at most one pull
request. The provider sits behind `SandboxProvider` in `packages/sandbox`:
`create`, `get`, `list`, `ensureAwake`, `resume`, `stop`, `extend`, `destroy`,
`exec`, `execStream`, `spawn`, `process`, `kill`, `readFile`, `writeFile`,
`address`, `saveSnapshot`, `getSnapshot`, `listSnapshots`, `deleteSnapshot`,
`usage`. A sandbox is `awake`, `asleep` or `gone`, or `starting` or `stopping` on
the way. `BoatProvider` is the real one; `FakeProvider` runs in memory with a clock
the test controls.

Three rules of that interface shape the API's jobs:

- `ensureAwake` has a deadline (90 seconds unless told otherwise) and ends with a
  typed error when it passes, so a wake never outlives its function unannounced.
- A wake that is given a new environment either starts the sandbox on it or fails
  with `conflict`. It never returns a sandbox that is running on the old one.
- The idempotency key on `create` guards one job's retries, not a design. The
  provider forgets it after a day and when the sandbox is destroyed. The design's
  row holds the sandbox id; a label finds a sandbox the row lost.

boat.dev gives each sandbox a full VM (Ubuntu 24.04 with Node, Bun, git, Docker,
Chrome and Claude Code) and a token-gated public address per port. It has no idle
detection and no wake-on-request, so the API owns the lifecycle.

| Step | What happens |
|---|---|
| Create | On the first message. The API checks credits, creates the sandbox from the repo's base snapshot (or Ponzu's base image), and the runner checks out `pz/<topic>` from the default branch. |
| First run in a repo | Claude sets the checkout up itself. The result is saved as the repo's base so later designs start warm. |
| Run | Ops go to the API as they happen. Commits go to the branch as they happen. |
| Sleep | Five minutes after the last activity the API stops the sandbox. A stop keeps the disk; memory survives for about ten minutes. |
| Wake | A message, answer or comment resumes it. The runner restarts as a systemd service, resumes the Claude session and takes its pending events. |
| Settle | On merge the design settles and its sandbox is destroyed. |
| Lost | A sandbox that cannot be resumed is recreated from the branch and the base. |

Waking is a job. The API records it in `jobs`, starts it with `waitUntil`, and a
one-minute cron finishes anything a function did not.

### The runner

`apps/runner` is one long-lived process per sandbox. It:

- runs Claude Code through the Agent SDK, one session per design, with the repo's
  own `CLAUDE.md`, skills, hooks and MCP servers;
- hosts the canvas tools in-process as an SDK MCP server. The tools work on a
  `Replica`, so they read the document synchronously and their ops stream to the
  API in the background;
- keeps one Chromium for `screenshot`, `record`, `export`, measuring and lint, next
  to the repo's dev server;
- writes the thread (assistant text, tool steps, questions) to the API as it goes;
- reports state: working, what it is working on, needs you, idle.

The runner dials the API with a token that is valid for one design. The API reaches
the runner through the sandbox's token-gated address to deliver events.

### The canvas tools

`packages/tools` has the tool set (`cloudTools`), its guides (`cloudGuides`,
`CLOUD_INSTRUCTIONS`) and what the runner hosts them on: `createCloudWorkspace`
builds the workspace for the sandbox's one design from the `Replica`, the renderer
and a handful of callbacks (`CloudHost`) for what leaves the process: the agent's
status and the artboards it is on, the intent of a request, storing an asset,
publishing an export, the design's link and the theme to render in.

- **One design.** No tool takes a file and none manages files. `update_design`
  sets the design's name and icon. A design may have no pages (a new one has
  none); `create_artboard` then makes the first page with the artboard, in one op.
- **No tool waits on the network.** A tool reads the replica's view and applies
  its op to it; the replica posts behind it.
- **The view is what will be committed.** An op is sanitized (`sanitizeOp`, the
  API's own step) before it is applied to the replica, and the tool's result says
  what that removed. Nothing the agent reads or screenshots is taken away by the
  commit.
- **Edits can be undone later.** When the replica drops an op the agent made (the
  API rejected it, or someone's change left it nothing to apply to), the next tool
  result says what was undone and why, whatever that call was. At the end of a
  turn and before the sandbox sleeps the runner waits on `design.settled(timeout)`,
  which keeps the replica retrying for as long as it waits, and gives the agent
  any notice no tool result carried.
- **Other people's ops** reach the same in-process event and presence hubs the
  agent's own do, so a board a person deletes stops showing as worked on.
- **Files go by sandbox path.** There are no design files. HTML too long for one
  call is written to a file by the agent, and `write_html` or `create_artboard`
  takes its path; the limits of an op (10,000 nodes, 1 MB) hold either way.
  `add_asset` takes a file's path, checks that the file is the kind its name
  says, hands the bytes to the host and returns the `assets/<name>` reference.
  `export` writes where the agent says, under `.png`, `.jpg` or `.pdf`, so the
  file can be committed, and adds a link when the host can publish one. Only the
  cloud's tools read a path: the local server's take none but to write.
- **The host's failures stay the host's.** A status or intent callback that throws
  or rejects is counted in telemetry and dropped: it is called after an edit has
  landed, and from the replica's listeners.
- **Without a renderer** `screenshot`, `record` and `export` say so and the rest
  work from declared sizes.

### Rendering

`ChromiumRenderer` in `packages/render` draws every screenshot, recording, export,
measurement and lint, inside the runner's process.

- **The browser is ours, not the image's.** The runner launches the Chrome Headless
  Shell that `playwright-core` is pinned to (`channel: "chromium-headless-shell"`),
  which the sandbox image installs with `playwright-core install --only-shell
  chromium`. Its version moves with our lockfile instead of with boat.dev's image,
  and on a small sandbox it idles at 140 MB and draws a landing page in 0.4 s, where
  the image's Google Chrome takes 290 MB and 0.9 s.
- **Chromium's sandbox stays on.** The runner is not root, and the VM allows user
  namespaces. A design can load remote images in the same machine that holds the
  owner's Claude credential. Where the kernel refuses (a container without user
  namespaces), the render fails saying so, and `PONZU_CHROMIUM_SANDBOX=0` turns the
  sandbox off without a change to code.
- **Work is bounded.** Two jobs at a time, the rest in a queue; 24 million device
  pixels in one image, past which the image comes back at a smaller scale; 60
  seconds a job, after which its page is closed; and an idle browser closes after
  two minutes. A browser that dies is replaced on the next job. A page is loaded
  once, at a scale its whole viewport fits the pixel budget at, and what is
  captured is drawn at a scale of its own: a node comes back at the scale asked
  for however long the board around it.
- **Fonts.** Designs name fonts a Mac has and Ubuntu cannot ship: Helvetica, Menlo,
  Georgia, `system-ui`. `packages/render/sandbox-fonts.json` lists what the image
  installs, and `stand-ins.ts` maps each name to a font of the same widths, so text
  wraps in a screenshot where it does on the canvas. A fontconfig file the renderer
  writes resolves the names. Where the Mac's font makes a taller or shorter line
  than its stand-in (Georgia, Monaco, Helvetica Neue, the Chinese, Japanese and
  Korean fonts), the page also declares the name as an `@font-face` over the
  stand-in with the Mac font's ascent and descent, so a line is as tall as on the
  canvas, to the pixel. The reference is Chrome on a Mac. Two things can't be made
  to match, and lint says so on every screenshot that has them: `system-ui`, where
  Inter stands in for San Francisco, close at text sizes and up to 12% wide in
  headings; and emoji, which on a Mac are narrower from 24px up and make their
  line a few pixels taller.
- **The dev server.** With `loopback: true` a design can load images, video, fonts
  and stylesheets from `http://localhost:<port>`. Chrome refuses those to a page at
  a public origin, so the renderer grants its pages Chrome's permission for this
  machine, and only this machine: the rest of the local network stays refused.
  Chrome then loads them itself. A request that needs a CORS header a dev server
  doesn't send (every font, a mask image) is fetched by the renderer instead, which
  holds the file whole on its way to Chrome and so refuses one over 25 MB.
- **Bun.** The runner runs on the Bun this repo pins. Under the Bun in boat.dev's
  image (1.3.14) the renderer's own tests hung.

### Events

A design has one ordered feed of things that happened: a message, an answer, a
comment, a canvas edit by a person, a failed check, a review.

| Priority | What | Effect |
|---|---|---|
| `now` | messages, answers, comments on a board Claude is working on | wakes; goes into the run mid-turn |
| `next` | other comments, failed checks, reviews | wakes; taken up after the current step |
| `later` | a person's canvas edits | no wake; Claude sees them before it next touches that board |

There is no watch loop. The local app told agents to poll for comments; in the cloud
that would be a model turn a minute and a sandbox that never sleeps. Events arrive
as turns instead, and `wait_for_activity` is gone.

### Needs you

When Claude asks a question, wants a secret, or hands off a link, the runner writes
a question row. Every client shows it in the composer, the design's row shows a
count, and the phone gets a push. An answer is an event with priority `now`.

Questions are rows that clients watch, and neither they nor events are encrypted.
The answer to a request for a secret is therefore not the secret: the API encrypts
the value into the repo's secrets, and the question and the event carry only the
secret's name. A Scratch design has no repo, so it has nowhere to keep one.

### Credentials

- **Git.** The sandbox has a credential helper that asks the API for a one-hour
  token for the design's repository. No GitHub secret is stored in the sandbox.
- **Commits** are authored by the person (their GitHub noreply address) and
  committed by the app.
- **Pull requests** are opened, read and merged by the API. The agent has no GitHub
  API token.
- **Claude.** The owner's credential (an OAuth token from `claude setup-token`, or
  an API key) is passed as an environment variable when the sandbox starts or
  resumes. It is never written to disk or baked into a snapshot. Moving it behind
  an egress proxy is hardening work, tracked below.
- **Repo secrets** are stored encrypted per repo and injected as environment
  variables at start.

## Assets and previews

Bytes live in R2. Each design has a random asset key; its files are served from
`https://assets.ponzu.cloud/<asset key>/…`. Images, CSS and video cannot send an
`Authorization` header, so the key in the path is the capability. The API returns
it only to people who can open the design, and it can be rotated.

User content is served from its own domain, `ponzu.cloud`, so nothing a design
contains ever shares an origin or a cookie with `ponzu.design`.

The runner uploads a light and a dark preview of the first page after each batch of
edits. The sidebar and the phone show those.

## Billing

Pay as you go in credits: $0.10 a credit, 5 credits per awake hour, 100 free per
member each month, pooled across a workspace. A card is asked for only when the
free credits are used up. A workspace has a monthly cap.

- Awake time is metered from the sandbox's state changes into `usage_events`.
- `credit_ledger` holds grants, use and adjustments. Balance and cap are checked
  before every wake. A running turn is never cut off.
- Stripe receives the billed part as metered usage.
- The iPhone shows usage and sells nothing.

## Clients

**Desktop.** The shell bundles the studio and serves it from a custom scheme
(`ponzu-studio://app`, the one origin outside the web that the API's CORS allows),
so the app and its UI always match. The main process owns sign-in, token storage
(`safeStorage`), refresh and the updater; the renderer asks it for an access token.
Every client names itself on each request (`X-Ponzu-Client: macos/2.0.0`). The API
can refuse one that is too old (426, `client_too_old`), and the shell then offers
the update.
On first launch the cloud app removes what 1.x left behind (the wake helper, the
`ponzu` shim, agent registrations).

**Studio** keeps the canvas as it is. `Canvas` depends only on the `CanvasSource`
interface; `CloudSource` in `packages/client` implements it on a `Replica`. The
shell around the canvas is new: guided setup, the sidebar, the thread, needs you,
the pull request tab, settings, sharing and presence.

**Mobile** is the same client on the same packages. Signing in, workspaces, the
designs list, the canvas, comments, the thread and answering questions. Push
notifications are new work on both sides.

The canvas draws every on-screen board as live DOM. The local app also had a
rendered-picture tier for heavy pages; it is not in the first cloud release.

## Security

| Boundary | Rule |
|---|---|
| Client and API | A WorkOS access token on every request, for a session the sign-in exchange let in. Clients never hold a GitHub, Claude or provider credential. |
| Person and design | GitHub decides, checked by the API on every request. |
| Sandbox and API | A token bound to one design. The API validates and sanitizes everything it sends. |
| Design HTML and the app | Sanitized on the way in, written out so that no text or attribute can be read as markup whatever the tree holds, drawn in a shadow root, under a strict content security policy. The preload bridge exposes the minimum. |
| Workspace and workspace | Every row belongs to one workspace. A design carries its workspace, and must agree with its repo's; the rows under a design (ops, thread, questions, presence and the rest) carry the design and reach the workspace through it, so there is no second copy to disagree. Live queries are written by the API, and one scoped to a workspace joins through `designs`. |

Stored secrets (Claude credentials, GitHub user tokens, repo secrets) are encrypted
with a key that exists only in the API's environment. Each is bound to the row and
column it is stored in, so a value copied anywhere else does not decrypt, and each
names the key that encrypted it, so the key can be rotated.

Every route says who may call it (anyone, a signed-in person, a design's
runner, or either of those two), and a route that does not is refused. A whole
area can be declared for people or for runners; opening a route to anyone is
said on that route and nowhere else. Errors leave the API as
`{ error: { code, message, details? } }` with a stable code and nothing of the
failure itself; logs carry ids and outcomes, never tokens, bodies or headers.

## Environments

| | API | Database | Auth | GitHub App |
|---|---|---|---|---|
| Development and the `cloud` branch | `api.ponzu.design` until cutover | Neon branch `dev` | WorkOS staging | `ponzu-dev` |
| Production, from cutover | `api.ponzu.design` | Neon default branch | WorkOS production | `ponzu` |

The API is deployed from the head of `cloud` by a workflow, which applies the
pending migrations to the database first; nobody deploys a branch to
production or migrates the shared database by hand. Every deployment holds the
environment's secrets, so only production's own domains are public: previews
and the unique URL of each deployment open only for the team.

Tests run against an in-process Postgres (PGlite), so they need no network. PGlite
is a single connection, so CI also runs the database's races, and each kind of
statement once, on a Postgres 18 beside the job. Migrations are generated by
drizzle-kit and applied in CI, over one connection and in one transaction.

## How this lands

Work happens on the `cloud` branch through pull requests into it. `main` is left
alone until cutover, so the 1.x app, the site and the phone keep shipping exactly
what they ship today and nothing has to be paused. Cutover is one pull request
from `cloud` into `main`, released as the next major version.

1. **Foundation.** Core (validation, sanitizing, the replica), the database, the
   sandbox provider, the API, the client package.
2. **The loop.** The runner, the sandbox lifecycle, the thread, events, GitHub.
   Ends with a design made by Claude in a sandbox, shown live in a client.
3. **The apps.** Desktop shell, studio, mobile.
4. **Billing.**
5. **Cutover.** Delete the local runtime, rewrite the docs and the site, release.
6. **Hardening.** Egress proxy for credentials, limits, observability, abuse
   controls, the picture tier.

## Known constraints

- boat.dev hosts in the EU only. The sandbox is far from the API and the database,
  which is why tools work on a local replica and post ops in the background.
- After a long sleep the first reply takes 20 to 50 seconds. The thread shows a
  waking state.
- A stop usually finishes in a few seconds but has taken 50, and boat.dev refuses a
  resume until it has. A message that arrives in that window waits for the stop.
- Neon Realtime is a public beta.
- A commit can be authored by the person or verified, not both. Repos that require
  signed commits on the pushed branch need the API commit path.
