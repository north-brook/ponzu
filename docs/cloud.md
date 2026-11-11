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
member, and sees only the repos GitHub shows them
(`GET /user/installations/{id}/repositories`, kept as their answers in
`repo_access`, below); the workspace's other repos stay hidden from them, and
someone who reaches it only through repos shared with them (an outside collaborator)
sees no other member. Ponzu stores only the role (Admin or Member). There are no
invitations.

GitHub's owners are a floor: whoever owns the account (the person, for a personal
account; an owner, for an organization, per `GET /user/memberships/orgs/{org}`) is an
Admin at every sync and cannot be demoted (409 `owner_is_admin`). Whoever installed
the App (as its `installation.created` webhook names them) starts as Admin; everyone
else starts as Member. A workspace with no Admin gets one from among the members of
its organization, longest-standing first, at the next sync of anyone in it; an outside
collaborator never becomes one that way, so a personal workspace waits for its owner.
Demoting the last Admin is refused (409 `last_admin`). Otherwise a role is changed
only by an Admin in Ponzu, never by a sync.

**Keeping it true.** `syncGithub` brings one person's workspaces in line with GitHub,
as that person, against their own rate limit: the installations their token lists,
their membership of each with what they may do in each of its repos (`write` or
`read` for the repos it lists, and for its others `read` if public, `none` if
private), and none of any other but
their own account's. An installation is read as the App (its workspace and every repo
it can see) only when Ponzu's copy is ten minutes old, disagrees with the person's
view, or lacks a repo they reach: those reads come out of the installation's hourly
budget, which its git tokens and permission checks share. The sync runs in the
background after each sign-in, on `POST /v1/github/sync` (the apps call it when they
come back to focus), and when a webhook says someone's access changed. Every step is
an upsert or a reconciliation, so it is safe twice at once and again after a failure;
memberships are dropped only once every installation is accounted for, and nothing is
dropped or marked removed from a list GitHub served only in part (more than 2,000
items). A repo the App loses is marked removed, never deleted. A suspended
installation keeps its workspace, marked, and while it is suspended nobody reaches its
repos through Ponzu (below). An uninstall is remembered by installation
id, which GitHub never reuses, so a read of GitHub that began before it cannot bring
the installation back. A one-minute cron reads again any installation nobody has read
for six hours, which is how an uninstall whose webhook was lost is found.

**Installing.** `POST /v1/github/install-link` returns GitHub's install page with a
`state` sealed by the API and recorded as a fifteen-minute, single-use auth state.
GitHub sends the browser to the App's Setup URL, `GET /v1/github/setup`, which has no
bearer token: the state says who started, the person's own token must reach the
installation (its id in the query is never trusted), and the answer is a small HTML
page with a way back to the app:

```
ponzu://github/setup?result=installed&workspace=<workspace id>
ponzu://github/setup?result=requested | pending | sign_in | failed
```

The app answers any of them by syncing. `pending` covers no state, a used or expired
one, and an installation the person cannot reach: whoever really installed the App is
caught up by its webhook and their next sync.

**Webhooks** arrive at `POST /v1/github/webhook`, verified against the raw body
before anything is read, deduplicated on `X-GitHub-Delivery`, and recorded with the
fields Ponzu uses as a job in the same statement before GitHub is answered: GitHub
never sends a delivery again by itself, so the job, not the delivery, carries the
retries (the cron runs a failed one again after a minute, doubling, for about two
hours). A delivery is a signal, not a record: an installation or repo event makes the
API read the installation from GitHub as it is now, and an access event (`member`,
`membership`, `organization`) syncs the person it names; when their GitHub token is
dead, their kept answers go stale (below), and one that says they lost access removes
them from that workspace at once. A `team` event, which names nobody, makes the
workspace's answers stale and syncs everyone in it; so does a change to the
installation's repos (`installation_repositories`), and a repo going private or
public, moving or being deleted makes the answers about that repo stale. However
Ponzu learns that a repo moved account or changed visibility (a webhook, a sync, the
sweep), the answers about it go stale; and the App being suspended, unsuspended or
uninstalled makes all of its workspace's answers stale. A pull
request event updates the design that owns its branch, newest `updated_at` wins, and
a merge settles the design. A failed check run or suite is an event with priority
`next` on that design's feed, and so is a submitted review by someone GitHub says can
push to the repo, asked the way every access question is (below). A review whose
`author_association` is not the repo's owner, a member of its organization or a
collaborator is dropped without asking, since on a public repo anyone can write one
and the agent reads it. A review event says who wrote it, how they relate to the repo
and, when they have signed in, which Ponzu person they are; the runner gives its text
to the agent as quoted input, never as an instruction. Events GitHub causes enter the
feed through the same row the commit statement writes for a person's ops
(`eventRow` in `@ponzu/db`). A revoked authorization
forgets the person's GitHub token and ends their sessions, once GitHub confirms the
token is dead.

**Opening a design** needs membership of its workspace and read access to its repo.
Steering it (messages, answers, merging) needs write access. Seeing a repo or its
designs in a list needs the same read access: GitHub hides a private repo, its name
included, from members who cannot read it, and so does Ponzu.

Every one of these questions is answered from one table, `repo_access`: (person, repo)
→ `admin | write | read | none`, and when GitHub was asked. Each answer is GitHub's,
by numeric ids, and reaches the table one of two ways:

- **A list, as the person.** `GET /user/installations/{id}/repositories` on their own
  token names every repo of the installation they were given permission on, and
  whether they can push: `write` or `read` for those. When the list is whole, the
  workspace's others are `read` if public (anyone can read one, and GitHub leaves it
  out of this list) and `none` if private. One call for the whole workspace, on their
  own rate limit. Their sync does it for every workspace; the workspace's repo list
  (`GET /v1/workspaces/:id`), its designs list and each renewal of `workspace.designs`
  do it for one, when any answer about any of its repos is more than a minute old. A
  list GitHub cut short (past 2,000 repos) says nothing of the repos it left out, so
  the oldest of those whose answer a reader acts on (one that lets them read, or a
  repo with a design), up to 20 at a time, are asked about as the App.
- **A question, as the App.** `GET /repos/{owner}/{repo}/collaborators/{login}/permission`
  about one repo, asked by `requireDesign`, `POST /v1/designs` and a review's check
  when there is no fresh answer. It takes the answer only when the account it names
  has the person's GitHub id (a login can change hands). GitHub answers `read` on a
  public repo for anyone, so the list and the question agree.

While the App is not installed on a workspace, or is suspended, the answer for every
repo of it is `none` without asking GitHub: its designs open for nobody (404), none
are listed, and no review reaches an agent.

The rules for reading it:

- An answer is taken as it is for a minute, so someone whose access is taken away
  loses it within a minute even if no webhook says so. Answers only replace older
  ones, so a slow request cannot bring back access a newer answer took away.
- Webhooks make it prompt. An access event syncs the person and writes their new
  answers at once; one that cannot (it names nobody, or their token is dead) makes the
  answers it concerns stale, so they are asked again before they are trusted, and a
  `workspace.designs` subscription drops what it should at its next renewal.
- While GitHub fails or limits the API, the last answer stands for ten minutes. A
  stale one never does. After that what needed it is refused (`upstream_unavailable`);
  in `POST /v1/live` only that query is.
- An answer is about a member: whoever reads it also requires the membership, so
  someone who leaves a workspace loses its repos and designs at once.

A Scratch design has no repo and is its owner's alone.

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
   On a miss it catches up and tries again. The same statement appends the events
   a person's ops make (see Events), so an op is never in the log without them, and
   copies the document's name and icon to the design's row when the ops changed
   them. The document is where the name lives: people rename with
   `PATCH /v1/designs/:id`, which commits `file.rename` and `file.icon` as theirs,
   and the agent with `update_design`.

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

A page of ops holds at most 500 ops and 3 MB of them (always at least one), so the
answer fits in what a Vercel function may send; when the last op is below `seq`, ask
again from there. `GET /doc` has no such bound yet: before designs grow past a few
MB it must stream, or hand out a checkpoint served from R2.

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
  (`workspace.designs`, `design.head`, `design.thread`, `design.questions`,
  `design.presence`, `me`).
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
the runner through the sandbox's token-gated address to say there are events to claim
("The runner protocol" below).

How Claude Code is configured, and why (`apps/runner/src/agent/sdk.ts`):

- **One session, one process.** One `query()` per design, fed through an input queue so the
  Claude Code process stays up between turns, and resumed by session id when the runner
  starts again. The session's transcript lives on the sandbox's disk
  (`~/.claude/projects/<cwd>/<session id>.jsonl`), which a stop keeps. A session whose
  transcript is gone (the sandbox was rebuilt) starts over. The SDK is pinned to the version
  released with the image's Claude Code (0.3.322 with 2.1.322), and runs the image's
  `/usr/local/bin/claude`, never a copy of its own.
- **Nobody to click "allow".** `bypassPermissions`, as `user` in a VM of its own.
  AskUserQuestion, plan approval and any other prompt still reach `canUseTool`, and become
  questions ("Needs you"). The result message is the only success signal: an API failure
  arrives as `subtype: "success"` with `is_error: true`.
- **The repo's own Claude Code.** `settingSources: ["project"]` loads the repo's CLAUDE.md,
  `.claude/settings.json` (hooks, permission rules), skills, commands and agents; the sandbox
  user's own settings, where boat puts a skill and an MCP server, do not load.
  `strictMcpConfig` is on and the runner passes the repo's `.mcp.json` servers itself, beside
  `ponzu`, so they start without an approval prompt nobody could answer. A hostile repo can
  therefore do anything as `user` that its code could: reach the Claude credential, a token
  for its own repository, the runner token and its own secrets. Nothing of another design.
  So can anyone who talks the agent into it ("Security": prompt injection).
- **Ponzu's part.** `CLOUD_INSTRUCTIONS` and a line on the checkout are appended to the
  `claude_code` system prompt. The canvas tools are the in-process MCP server `ponzu`,
  always loaded rather than behind tool search, each tool's `ToolDef` mapped to the SDK's
  form once and its screenshots returned as images.

### The canvas tools

`packages/tools` has the tool set (`cloudTools`), its guides (`cloudGuides`,
`CLOUD_INSTRUCTIONS`) and what the runner hosts them on: `createCloudWorkspace`
builds the workspace for the sandbox's one design from the `Replica`, the renderer
and a handful of callbacks (`CloudHost`) for what leaves the process: the agent's
status and the artboards it is on, the intent of a request, storing an asset,
publishing an export, the design's link and the theme to render in.

- **One design.** No tool takes a file and none manages files. `update_design`
  sets the design's name and icon. A new design starts with one empty page
  (`POST /v1/designs` makes it); a design may still come to have none, and
  `create_artboard` then makes the first page with the artboard, in one op.
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
  canvas, to the pixel. The reference is Chrome on a Mac. Three things can't be
  made to match, and lint says so on a screenshot that has them: `system-ui`, where
  Inter stands in for San Francisco, close at text sizes and up to 12% wide in
  headings; emoji, which on a Mac are narrower from 24px up and make their line a
  few pixels taller; and Chinese, Japanese or Korean text in a stack that names no
  font for it, which fallback draws at Noto's line height where the design sets
  none. Fallback goes by what is installed, so the image holds the fonts in that
  list and no others for those scripts.
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

A person's stop is an event too (`stop`, priority `now`): it interrupts the running turn and
is put into nothing. How each kind reaches the model is in "The runner protocol".

There is no watch loop. The local app told agents to poll for comments; in the cloud
that would be a model turn a minute and a sandbox that never sleeps. Events arrive
as turns instead, and `wait_for_activity` is gone.

### Needs you

When Claude asks a question, wants a secret, or hands off a link, the runner writes
a question row. Every client shows it in the composer, the design's row shows a
count, and the phone gets a push. An answer is an event with priority `now`.

A question outlives the sandbox's sleep. The API keeps a sandbox awake only while its
runner is `working`, so one that waits on a person sleeps after five minutes; its question
stays open, the design stays `needs_you`, and the answer wakes the sandbox and goes into
the resumed session as a message that says again what was asked. A question is withdrawn
only when the run moves on: a person stops the turn, or the turn ends, or the next turn
ends for one an earlier run left open.

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

## The runner protocol

What the runner and the API say to each other. The runner's whole view of the API is
`RunnerApi` (`apps/runner/src/api/api.ts`); every body below is a type in
`apps/runner/src/api/protocol.ts`, which the apps import for the thread's items
(`@ponzu/runner/protocol`). `apps/runner/src/api/fake-http.ts` serves the in-memory fake
behind these routes, and is the reference for what each answers.

### Rules for every call

- **Who.** The bearer is the runner token (`pzr_…`), declared with `access.runner`. A runner
  route acts on `actor.designId` and takes no design id; a document route's `:id` that is not
  the token's design answers 404 `not_found`. A token that is unknown, expired or revoked
  answers 401 `token_invalid` everywhere. The API revokes a design's runner tokens when the
  design is deleted or settled, so that is also how a runner hears its design is gone. The
  runner names itself: `X-Ponzu-Client: runner/<version>`.
- **One runner at a time: the lease.** `POST /v1/runner/session` mints a runner id (`rnr_…`)
  and records it as the design's runner, replacing any before it. Every other call, the
  document routes and git's credential helper included, carries it as `X-Ponzu-Runner`, and
  the API answers 409 `superseded` to a call without the current one. Two processes for one
  design (a botched restart, a second sandbox) would otherwise resume the same Claude session
  and act on the same events twice; with the lease the older one is refused at its next call.
- **Stopping for good.** On 401 `token_invalid` or 409 `superseded`, from any call, the
  runner interrupts the turn, writes nothing more, closes Claude Code and exits 78, which
  systemd does not restart (`RestartPreventExitStatus`). Only a new start of the sandbox, with
  a new environment, brings a runner back.
- **Batch, never chat.** The sandbox is in the EU and the API in US East, about 100 ms each
  way, so each route takes many things at once and the runner sends what piled up: thread
  writes at most about three a second, state when it changes and on a heartbeat, acks,
  questions and usage in batches. Nothing on the runner waits on a call except its start and
  an upload.
- **Retries.** A call that gets no answer, or 408, 429 or a 5xx, is sent again unchanged after
  a wait that doubles from half a second to half a minute, for as long as the runner lives:
  thread writes, state, acks, questions, withdrawals and usage alike. Every route is safe to
  repeat, as each says below. Any other 4xx is not retried: the runner logs it and drops what
  it carried. A question the API refuses is taken back from the agent (its tool call is denied
  with a reason, so the turn goes on) and said in the thread (`question_failed`).
- **Errors** are the API's: `{ "error": { "code", "message" } }`. Beyond the common ones
  (`invalid_request`, `payload_too_large`, `rate_limited`, `database_unavailable`,
  `upstream_unavailable`), a route lists those that mean something to the runner.
- **Ids the runner chooses** (`ti_…`, `q_…`, `clm_…`) are a prefix and 16 characters of the API's
  alphabet (`packages/db/src/ids.ts`), and the API keys them by design: a thread item or a
  question is found by `(design_id, id)`, so the same id in another design is another row,
  and nothing a runner sends can reach or reveal another design's.
- JSON is camelCase; times are ISO 8601.

### Routes

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/v1/runner/session` | `{}` | `RunnerSession`, with the lease `runnerId` |
| POST | `/v1/runner/events/claim` | `{ claimId, limit?: number }` | `{ events: RunnerEvent[], seq }` |
| POST | `/v1/runner/events/ack` | `{ ids: string[], claudeSessionId: string \| null }` | `{ acked: number }` |
| POST | `/v1/runner/thread` | `{ items: ThreadWrite[] }` | `{ items: [{ id, seq, streaming }] }` |
| PUT | `/v1/runner/state` | `{ state, status, artboards, claudeSessionId }` | `{ seq }` |
| POST | `/v1/runner/questions` | `{ id, kind, payload }` | `{ id, status }` |
| POST | `/v1/runner/questions/withdraw` | `{ ids: string[] }` | `{ withdrawn: number }` |
| POST | `/v1/runner/uploads` | `{ files: [{ purpose, name, contentType, size, sha256 }] }` | `{ files: [{ id, put: { url, headers }, expiresAt }] }` |
| PUT | `put.url` from the above | the bytes, with `put.headers` and no bearer | 200 |
| POST | `/v1/runner/uploads/complete` | `{ ids: string[], seq?: number }` | `{ files: [{ id, ref, url }] }` |
| POST | `/v1/runner/git-credential` | `{ protocol, host, path }` | `{ username, password, expiresAt }` |
| POST | `/v1/runner/git-credential/erase` | `{ protocol, host, path }` | 204 |
| POST | `/v1/runner/usage` | `{ turns: TurnUsage[] }` | `{ recorded: number }` |
| POST | `/v1/designs/:id/ops` | `{ ops: [{ id, op }] }` | `{ committed, rejected, seq }` (Committing) |
| GET | `/v1/designs/:id/ops?after=N` | none | `{ ops, seq }`, 410 when N is too old (Reading) |
| GET | `/v1/designs/:id/doc` | none | `{ doc, seq }` (Reading) |
| POST | runner `/poke` | none | 204 |
| GET | runner `/health` | none | `{ ok: true, state }` |

Every route but the session's, the upload `PUT` and the runner's own two answers 409
`superseded` without the current `X-Ponzu-Runner`.

### Session

`POST /v1/runner/session` is the runner's first call: everything it needs to start, and the
lease.

```
RunnerSession = {
  runnerId,                                      // rnr_…, this process's lease: X-Ponzu-Runner
  design: { id, name },
  repo: { owner, name, defaultBranch } | null,   // null for Scratch
  branch: string | null,                         // pz/<topic>, null for Scratch
  claudeSessionId: string | null,                // the last one an ack or a state report named
  model: string | null, effort: "low" | "medium" | "high" | "xhigh" | "max" | null,
  author: { name, email },                       // the person: <id>+<login>@users.noreply.github.com
  committer: { name, email },                    // the App's bot
  assetBase,                                     // https://assets.ponzu.cloud/<asset key>
  link,                                          // opens the design in Ponzu
  theme: "light" | "dark" | null,                // the owner's canvas, once known
  openQuestions: string[],                       // still open from an earlier run
  seq                                            // the design's head
}
```

Each call mints a new `runnerId` and makes it the design's; the runner keeps the last one it
was answered with, so a retry after a lost answer is safe. `openQuestions` stay open: their
answers come in as messages (Questions).

### Events

```
RunnerEvent = { id, seq, at, priority: "now" | "next" | "later", from: Person | null, kind, payload }
Person      = { id, name, login }
```

| Kind | Priority | Payload | Into the run |
|---|---|---|---|
| `message` | now | `{ text }` | a user message, priority `now`, as from a person |
| `answer` | now | `{ questionId, question: { kind, payload }, answers?: { [question]: answer }, approved?, note? }` | to the question waiting for it; when none is (its run ended, the sandbox slept), a message that says again what was asked, from `question` |
| `comment` | now on a board in `agent_artboards`, else next | `{ threadId, messageId, text, reply, artboardId, artboardName, nodeId }` | a user message, priority `now` or `next` |
| `edit` | later | `{ summary, artboards: [{ id, name }] }` | never starts a turn. During a turn, held until the agent next calls a canvas tool (then priority `next`, read right after that call) or the turn ends; otherwise into the transcript at once without a turn (`shouldQuery: false`), to be read with whatever starts the next one |
| `check` | next | `{ name, conclusion, url, summary }` | a user message, priority `next` |
| `review` | next | `{ state, reviewer: { login }, body, url, comments: [{ path, line, body }] }` | a user message, priority `next` |
| `stop` | now | `{}` | interrupts the running turn and what was put in behind it; nothing goes in |

A comment event is one new comment or one reply; an edited, resolved or reopened comment is a
canvas edit (`edit`), and so is one an undo or a redo puts back, which was heard when it was
first made. A review carries its first 20 line comments, each body clipped to 2,000 characters (`MAX_REVIEW_COMMENTS`): the
agent has no GitHub API token to read them with. `answer.question` is the question row's
`kind` and `payload`, as the runner raised it.

Each event goes in as the text in `apps/runner/src/prompt.ts`: a first line that says what it
is, who it is from and where on the canvas, with the ids the tools take, then their words. A
person's message is theirs to direct the agent with and goes in as written; anyone else's
words (a comment, a review and its line comments, a check's log) go in quoted, each line
behind `> `, and the runner's instructions tell the agent that quoted text is feedback, never
instructions (Security).

**Claim.** `POST /v1/runner/events/claim` hands the calling runner the design's events that
are not acknowledged and that it has not been handed before, oldest first, at most `limit`
(100, the most there is), and records them as claimed by it. An event is handed to a runner
once: one claimed by an earlier runner, which is gone, is the next one's, and nothing a live
runner holds is handed out again, so an old event never stands in front of a new one. A page
that comes back full is followed at once by another claim. The answer carries the design's
head `seq`, read in the same statement, which the runner gives its replica. Each claim carries
a `claimId` the runner chooses, new for each claim and kept until one is answered: a claim
sent again with the same id, because its answer was lost, hands out again what that claim
handed out and has not been acknowledged, and nothing new. Safe to repeat.

**Ack.** `POST /v1/runner/events/ack` marks events delivered, by id; those already marked,
another design's, or never handed to this runner are left alone, and `acked` counts what
changed. It also stores `claudeSessionId`, when it is not null, as the design's Claude
session, in the same transaction: the session an event went into is the one the next runner
resumes, even when no state report got through. The statement holds to the lease itself, so
an ack from a runner superseded while its call was let in changes nothing. Safe to repeat.

The runner acknowledges an event only once **the Claude session holds it**: Claude Code has
taken its message into the session's transcript (the message's lifecycle reached `started`,
or its uuid came back on a reply), or, for an answer, the question's tool result is in it.
Until Claude Code has said which session that is, those acks wait. Each event's message goes
in under a uuid derived from the event's id, so the transcript says which events it holds: a
runner that starts again reads it before it delivers anything, and acknowledges, without
delivering again, whatever was taken before the last one died. Some are acknowledged without
going in, with `claudeSessionId` null when nothing else in the batch went in: a stop once its
interrupt is sent; what a stop cancelled; a kind this runner does not know; and a message
Claude Code turned away (a repo's `UserPromptSubmit` hook), which would only be turned away
again and is said in the thread instead (`message_refused`).

### The thread

```
ThreadItem  = { id, seq, at, streaming, kind, payload }
kind        payload                                                       written by
message     { text, from: Person }                                        the API, with the event
comment     { threadId, messageId, text, artboardId, artboardName, from } the API, with the event
assistant   { text }                    markdown, streams                 the runner
tool        { label, steps, artboards } one stretch of work               the runner
notice      { type: "waking" | "resumed" | "started" }                    the runner
            { type: "question", questionId, header, text }                the runner
            { type: "error", code, message }                              the runner
            { type: "stopped", by: Person | null }                        the API, from the runner's
                                                                          { type: "stopped", eventId }
            { type: "pull_request", number, url, title, state }           the API
```

A client renders the thread from these alone. A `tool` item is a stretch of tool calls
between two things the agent says, folded to one line: while it streams it is the working
line ("Reading the repo", `Drawing "Pricing · B"`, "Running the dev server", or what the agent
said with set_status); once finished it is named by the step that says most about it (what
the agent made over what it ran over what it read), and may be folded or hidden. `artboards`
are the boards the agent is on during the stretch. No tool input or output is written. An
`assistant` item cut off by an interrupt is finished with the text it had. `error` codes:
`clone_failed`, `claude_auth`, `claude_limit`, `model_unavailable`, `max_turns`, `turn_failed`,
`agent_exited`, `message_refused`, `question_failed`. The `waking` notice becomes `resumed` or
`started` once Claude Code is up.

`POST /v1/runner/thread` writes items by the id the runner chose (`ti_…`): an id the thread
does not have is appended, an item still streaming has its payload replaced, and a finished
one is left as it is (the answer says `streaming: false`, and the runner sends nothing more
for it). A runner writes only `assistant`, `tool` and the notices it owns (`ThreadWrite`):
`waking`, `resumed`, `started`, `question`, `error`, and `stopped` as `{ type: "stopped",
eventId }` naming one of the design's `stop` events, which the API stores as `{ type:
"stopped", by }` with the person from that event. Any other notice type, or a `stopped` that
names no stop of the design, is 400 `invalid_request` and the whole write is refused: what only
the API knows (a pull request, who stopped the run) is never taken from a sandbox, where the
agent can run anything. At most 32 items a call; agent text is clipped to 32,000 characters,
so a payload stays far under the table's 256 KB. Safe to repeat.

### State

`PUT /v1/runner/state` says what the agent is doing, as the design's row shows it:

```
{ state: "working" | "needs_you" | "idle",
  status: string | null,       // the working line; while not working, what is wrong, if anything
  artboards: string[],         // what the agent is on, from the canvas tools
  claudeSessionId: string | null }
```

`needs_you` while the agent waits on a person, and while a question it asked stays open
after its run (Questions); `status` while not working is a clone that failed or a turn that
failed on Claude's credential or limit, until a turn works. The runner sends it when it
changes, at most twice a second, and every 30 seconds whatever happens: the **heartbeat**.
The API stores the session id, when not null, for the next resume, keeps a sandbox awake while
its runner reports `working`, and takes one it has not heard from in 90 seconds as dead. The
answer is the design's head `seq`. Safe to repeat: the last one wins.

### Questions

`POST /v1/runner/questions` raises one, under an id the runner derives from the tool call
(`q_…`), so raising it again is safe:

```
kind        payload
question    { questions: [{ header, question, options: [{ label, description }], multiSelect }] }
plan        { plan }                               (markdown)
permission  { tool, title, description }
```

The person's answer comes back as an `answer` event. When the run moves on without one (the
turn ended, a person stopped it), the runner withdraws it with `POST
/v1/runner/questions/withdraw`; the API marks open ones cancelled and leaves the rest. A
question is never withdrawn because the sandbox goes to sleep: it stays open, and its answer
wakes the sandbox and goes into the resumed session as a message (Needs you). One left open
by an earlier run is withdrawn when the next turn ends. The runner sends a question before
any withdrawal of it. Both are safe to repeat.

### Uploads

Bytes go straight to storage, never through a function (4.5 MB): `POST /v1/runner/uploads`
says what is coming (`purpose`: `asset`, `export` or `preview`; a file name with its
extension; type, size and SHA-256), and answers with a signed address per file that takes
exactly those bytes for ten minutes. The runner PUTs them there with the headers given and
no bearer, then `POST /v1/runner/uploads/complete` with the ids. An asset's `ref` is
`assets/<name>`, as markup uses it; an export's `url` is its link. Previews are `light.png`
and `dark.png`, of the first page laid out as the canvas shows it, with `seq` the design's
seq they show (`designs.preview_seq`); the runner draws them a few seconds after the canvas
stops changing and its edits reach the API. Completing an id again is safe; 404 `not_found`
for an id whose bytes never arrived.

### Git

The checkout's git asks for credentials through a helper, `bun git-credential.js <runner id>`
(`credential.https://github.com.helper`, with `credential.https://github.com.useHttpPath
true`, and an empty helper before it so no other is asked). It reads the runner token from the
environment git passes on, sends the runner id it was configured with as `X-Ponzu-Runner`, so
the git of a superseded runner gets nothing, writes nothing down, and calls `POST
/v1/runner/git-credential` with what git asked: `{ protocol: "https", host: "github.com",
path: "<owner>/<name>.git" }`. The API mints a one-hour installation token for that one
repository (`contents: write`, `metadata: read`), or reuses one with ten minutes or more
left. 403 `forbidden` for any other host or repository, 404 `not_found` for Scratch, 502
`upstream_unavailable` when GitHub fails. When GitHub refuses a token, git calls `erase`, and
the API drops the token it was reusing. Both are safe to repeat. A token is kept for reuse only
in the memory of the function instance that minted it, never in a row, so an `erase` that lands
on another instance leaves the first one's in use until it has ten minutes left.

At start the runner sets `author.*` to the person and `committer.*` to the App's bot in the
global git config, clones the repository into `~/work/<name>` (or fetches, when the disk kept
it), and checks out the design's branch: the local one, else the one on GitHub, else a new one
from `origin/<default branch>`. Work on disk is never reset. A clone that fails is a
`clone_failed` notice and the design's status, and the run goes on in an empty folder, so the
canvas still works; the agent is told the repository could not be checked out, and the next
start of the sandbox tries again.

### Usage

`POST /v1/runner/usage` records what each turn used, by model, under the turn's result id, so
recording it again changes nothing:

```
TurnUsage = { id, claudeSessionId, at,
              models: [{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }] }
```

Claude Code reports a session's running totals; the runner sends the difference from the
totals the last turn reported, which it keeps on disk across restarts. After a crash Claude
Code restores the totals it saved at its last clean exit, and a turn that would come out
below zero counts as zero.

### People's side

A person steers the run through the design's routes, each `requireDesign` with write access
but the thread's history, which takes read:

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/v1/designs/:id/messages` | `{ text, attachments?: string[] }` | 201, the `message` `ThreadItem` |
| POST | `/v1/designs/:id/questions/:questionId/answer` | `{ answers? }` or `{ approved, note? }` | `{ id, status }` |
| POST | `/v1/designs/:id/stop` | none | 204 |
| GET | `/v1/designs/:id/thread?before=&limit=` | none | `{ items: ThreadItem[] }`, oldest first, at most 50 |
| POST | `/v1/designs/:id/uploads` | `{ files: [{ name, contentType, size, sha256 }] }` | as `/v1/runner/uploads` |
| POST | `/v1/designs/:id/uploads/complete` | `{ ids }` | as `/v1/runner/uploads/complete` |

A message writes its thread item and its `now` event in one statement. Its `attachments` are
files of the design by reference (`assets/<name>`), uploaded first; the item's payload and the
event's carry them as `[{ ref, contentType }]`. A person uploads images only, and each is kept
under its own name with six random characters added (`paste-k3v9qz.png`), so it never replaces
one of the design's files. An answer is checked against what was asked (every one of a
`question`'s questions by its text and no other, or `approved` for a `plan` or `permission`),
since it closes the question for good; the first wins, and an answer to a question that is
not open is 409 `question_closed`. It writes the `answer` event in
the statement that closes the question, carrying the question as it was raised. A comment a
person posts on the canvas reaches the thread the same way: the commit statement writes the
`comment` item beside its event.

Each of these, and every op a person commits (undo and redo included), then calls
`requestWake` (`apps/api/src/sandboxes/wake.ts`): a message, an answer or a comment records a
wake for the design, one at a time, and every reason pokes the runner when the design's
sandbox is awake. A stop and an edit record none: a sleeping sandbox is running nothing to stop,
and an edit is `later`. `requestWake` never fails the request that called it: what that wrote
is written, and a wake it could not record is logged (`wake_failed`).

### The other way: poke and health

The runner listens on one port (4600), which the API reaches through the sandbox's
token-gated address. `POST /poke` carries nothing, and the runner trusts nothing about it: it
only claims, from the API, with its own token. The API pokes when it adds an event to an awake
design's feed and when a person's op moves an awake design's head, and does not retry a poke
that fails: the runner also claims once a minute, and each claim and state answer carries the
head. `GET /health` answers `{ "ok": true, "state": "working" | "needs_you" | "idle" }`.

### Environment

The sandbox starts the runner (a systemd service that sources boat's
`/run/ascii-secrets/env.sh`) with `PONZU_API_URL`, `PONZU_DESIGN_ID`, `PONZU_RUNNER_TOKEN` and
exactly one of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. With both it refuses to
start: Claude Code would use the key without a word and bill its account. The rest is
optional and in `apps/runner/README.md`. On SIGTERM it stops the turn, waits a few seconds for
the agent's edits to reach the API, reports its final state (`needs_you` when a question
stays open) and exits.

## Assets and previews

Bytes live in R2. Each design has a random asset key; its files are served from
`https://assets.ponzu.cloud/<asset key>/…`. Images, CSS and video cannot send an
`Authorization` header, so the key in the path is the capability. The API returns
it only to people who can open the design, and it can be rotated.

User content is served from its own domain, `ponzu.cloud`, so nothing a design
contains ever shares an origin or a cookie with `ponzu.design`.

The runner uploads a light and a dark preview of the first page after each batch of
edits. The sidebar and the phone show those.

Under a design's asset key:

| Key | What |
|---|---|
| `assets/<name>` | a file of the design, as markup references it |
| `previews/<seq>-light.png`, `previews/<seq>-dark.png` | the previews of `designs.preview_seq` |
| `exports/<upload id>-<name>` | a file an export link reaches |

A client builds a preview's address from the design's head: `<assets url>/<asset key>/previews/
<preview seq>-<theme>.png`. A preview waits under `staging/` at the bucket's root until it is
completed with its seq, and is copied into place then; a bucket lifecycle rule can clear what is
never completed. Previews replaced by later ones are deleted.

Uploads are signed (SigV4, `apps/api/src/deps/sigv4.ts`) for their type, exact size, SHA-256
(`x-amz-checksum-sha256`, which R2 checks against the bytes), cache rule and disposition, for
ten minutes; completing one checks that storage holds that size and checksum. Kinds and sizes:
assets are the images, fonts and videos `add_asset` takes, up to 20 MB; exports PNG, JPEG or
PDF, up to 50 MB; previews PNG, up to 5 MB; a person's upload an image, up to 20 MB.

An SVG can run script when a browser opens it by itself, so it is stored with
`Content-Disposition: attachment`: opened directly it is saved, not shown, and as an `<img>` or
a CSS `url()` (which run no script) it draws as ever. Object storage cannot attach a
Content-Security-Policy to an object; a response header rule on the assets zone could add one
(`default-src 'none'; style-src 'unsafe-inline'; sandbox`) as a second wall.

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

**Prompt injection.** The agent runs as the sandbox's user with permissions bypassed, beside
the owner's Claude credential (in Claude Code's environment, and in `/proc` for anything
running as that user), the runner token and the repo's secrets. Anyone whose words reach the
model can try to talk it into a command: a person commenting on the design, anyone reviewing
its pull request (on a public repository, anyone on GitHub), a check's log, the repo's own
files. Such a command can read and send the Claude credential, the runner token and the repo's
secrets. What limits it today: other people's words reach the model quoted, under instructions
that quoted text is feedback and never asks for credentials or for anything to be sent
elsewhere; the runner token is good for one design and can write nothing an agent could not
(a runner cannot write the API's notices, such as a pull request's), and a stolen one can at
most take the lease and stop that design's runner; a git token is good for an hour and one
repository. Scrubbing the credential from what the agent's tools inherit
(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) is not used: in Claude Code 2.1.322 it turns
`bypassPermissions` back to `default` unless every tool is listed in `allowedTools`, and
anything running as the same user reads the environment from `/proc` anyway. The boundary that
closes this is in Hardening: Claude Code's tools as a user of their own, and the Claude
credential behind an egress proxy, so nothing in the sandbox holds it.

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
6. **Hardening.** Egress proxy for credentials, Claude Code's tools as a user apart
   from the runner's, limits, observability, abuse controls, the picture tier.

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
