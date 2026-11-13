# Ponzu Cloud

This is the architecture of the cloud rewrite. It is the contract the code on the
`cloud` branch is built against; where code and this file disagree, fix one of them
in the same pull request.

Ponzu stops being a local app. You sign in with GitHub, pick a repo, and describe what
you want to make. A sandbox in the cloud checks the repo out and runs Claude Code on
your own Claude plan; Claude draws on the canvas, changes the code, and opens a pull request.
Everyone with access to the repo sees the same canvas and thread, live, on the Mac
and the iPhone.

There is no local runtime, no pairing, no outside agents, no importer and no
backwards compatibility with the 1.x app.

## Principles

1. **The database is the canvas.** Postgres holds every board, comment, thread and
   event. Nothing lives only in a sandbox or on a device.
2. **A sandbox is a cache.** It holds one canvas's checkout and one Claude session.
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
   one canvas and nothing else.

## Layout

```
apps/
  api/       HTTP API on Vercel (Hono, Node runtime, iad1). api.ponzu.design, dev at api-dev
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
  sandbox/   canvas sandboxes on Vercel Sandbox, and a fake of it for tests
  client/    typed API client, live queries, the cloud canvas source
```

Deleted at cutover: `packages/store`, `packages/tools/src/local`, core's 1.x modules,
`examples/`, and the `/gh`, `/local`, `/open`, `/share` and badge routes in `apps/web`.
The 1.x command line, its local server and MCP packages, the agent plugin and the
marketplace manifests are already gone from this branch.

Where things run:

| | Runs | Holds |
|---|---|---|
| Clients | the person's device | a session token, a cache |
| API | Vercel functions | every credential, all authorization |
| Store | Neon Postgres, Cloudflare R2 | the system of record; R2 holds bytes |
| Sandbox | one Vercel Sandbox per canvas, in iad1 | a checkout and a Claude session |

## Identity and access

**Sign-in** is GitHub through WorkOS. Both apps run an authorization-code flow with
PKCE in the system browser, then post `{ code, code_verifier }` to
`POST /v1/auth/exchange`. The API exchanges it with WorkOS, stores the person's
GitHub user token encrypted, and returns WorkOS access and refresh tokens. The
GitHub token never reaches a device.

- The Mac app redirects to a loopback address (`http://127.0.0.1:<port>/auth/callback`).
  Each press of Continue with GitHub is its own attempt (port, state, verifier) that can
  finish for ten minutes whatever the window does; the first back signs in and the rest
  close, as do the oldest past three and every one when Ponzu quits. The page the browser
  lands on is written after the exchange has answered, so it says how it went. It is a
  handoff (below) with nothing to open: Ponzu comes forward by itself once it has signed the
  person in, and the page says "Ponzu has it" and closes as Ponzu takes the focus. One that
  didn't finish stays, saying why.
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
same workspace and its canvases. A person's workspaces are the installations their
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

**Who is in a workspace** is everyone GitHub gives access to at least one repo of
its installation, whether or not they have opened Ponzu: that is the count on "Where
do you build?", Settings › Members and Share. The API reads it as the App, once for
the whole installation and never per person (`github/people.ts`): each installed
repo's people (`collaborators`, affiliation all, with their permission and name,
over GraphQL a hundred at a time), an organization's members for their roles (which
takes `members: read`), and for a personal account its person. It keeps them in
`workspace_people` (workspace, GitHub id, login, name, avatar, how they reach it,
their best permission and each repo's, when last seen), not as `users` rows; someone
who signs in is matched by their GitHub id, and only then has a membership and a
role. The read is a job of its own (`github.people`), so neither a person's sync nor
a webhook's work waits on it or fails with it: a reconcile that finds the last read
an hour old records one and runs it beside the request, and the `installation`,
`installation_repositories`, `member`, `membership`, `organization` and `team`
webhooks record one for the end of their minute, after their own work (taking access
away first), so a burst of deliveries is one read, made by the cron. A read asks about
at most 100 repos, those asked longest ago first (`repos.people_read_at`), so a bigger
installation is read whole over a few, and reads 1,000 people a list. Each repo whose
list came back whole replaces what was known of it, one cut short only adds, a repo
the installation lost takes its entries with it, and someone left reaching no repo is
gone; `people_complete` only says, for show, whether the last read was of every repo
whole. The organization's members only label people owner or member: without
`members: read`, someone new is taken for an outside collaborator. A suspended
installation's people stay as last seen; an uninstalled one's are forgotten. What
anyone may do is still their own sync's answer (`memberships`, `repo_access`, which
wins over the list's per-repo snapshot for anyone who has one); this list grants
nothing. Free credits still count the people who have opened Ponzu.

**Who sees whom** follows what GitHub would show them, chosen in the query
(`listWorkspacePeople`, `countWorkspacePeople`, `listRepoPeople`): an owner of the
account sees everyone; a member sees its owners and members, and an outside
collaborator only when they share a repo the member can push to (GitHub shows a
repo's collaborators only to those); an outside collaborator sees only themselves and
no count. In Share, someone who can only read the canvas's repo is not shown its
outside collaborators.

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

**Installing.** `POST /v1/github/install-link` returns GitHub's account picker for the App
(`installations/select_target`: every account of the person's, to install the App on one or
change the repos of one that has it), or its install page for one account when the app
suggests one (`installations/new/permissions`). The picker is asked for by name because the
plain install page skips it once the App is installed anywhere and opens that installation's
settings, where no other account can be chosen. Either carries a
`state` sealed by the API and recorded as a fifteen-minute, single-use auth state, and
the app's own handle on it (`id`). GitHub sends the browser to the App's Setup URL,
`GET /v1/github/setup`, which has no bearer token: the state says who started, the
person's own token must reach the installation (its id in the query is never trusted),
and the answer is a handoff page (below). Its link back to the app is

```
<scheme>://github/setup?result=installed&workspace=<workspace id>
<scheme>://github/setup?result=requested | pending | sign_in | failed
```

The app answers any of them by syncing and moving on (an installed workspace opens).
`pending` covers no state, a used or expired one, and an installation the person cannot
reach: whoever really installed the App is caught up by its webhook and their next sync.

Which app the page hands back to is what the app said when it asked for the link
(`scheme`), kept in the state's row, never in anything the browser brings:

- `ponzu` (Ponzu), `ponzu-dev` (Ponzu Dev), or `ponzu-preview` (Ponzu Dev's earlier
  name): the page opens that link by itself.
- `none`: a build that takes no links, which is Ponzu Local (run from a checkout; on a
  Mac it lives inside the generic Electron.app and can declare no scheme). The page opens
  nothing and says "Ponzu has it. You can close this tab."
- Nothing said, or no state at all (installed from github.com, or saved from the
  installation's settings on GitHub, which sends no state): not known. The page opens
  nothing and says to go back to Ponzu, which catches up as it comes to the front. A guess
  could open an app the person doesn't have, or the release from an environment that
  serves the development builds, so the API never guesses.

The app never needs the link. While GitHub's page is open it asks
`GET /v1/github/installs/:id` every two seconds (`waiting`, `settled` with the result and
workspace, or `expired`); the setup page writes its outcome on the state's row as it is
made. Once settled, Ponzu comes forward by itself and takes the outcome exactly as it
would the link (`apps/studio/src/app/installs.ts`). A build that takes links usually
hears both; whichever comes first is acted on and the other is dropped.

This is why the founder's development build was offered `ponzu://` on 11 November 2026:
Ponzu Local sent no scheme, and the API, taking silence for Ponzu, recorded `ponzu`.
Ponzu Local now says `none`, and silence now means not known.

**Handing back to the app.** Every page a browser is left on is a handoff, the pattern of
the old product's `/local` page: the site's lockup in the corner (outlined), the Ponzu
mark, a heading in the display face and one plain line, the app's link opened
by the page itself, and a watch for the app taking over (launching an app takes the
page's focus or hides it). When it does, the page says Ponzu has it and closes itself (or
says the tab can be closed, where the browser won't let a tab it didn't open close).
When nothing has taken the link after two seconds, the page offers it again as a button,
in words that say what still happens without it; focus that leaves later, after the
browser's prompt, still counts. Where there is no link (a build that takes none, or the
shell's own sign-in page), the page says Ponzu has it and closes once Ponzu comes forward.

The API's setup page and the shell's sign-in page are one document
(`@ponzu/core/handoff`), self-contained: no request of its own, one fixed script and one
fixed style sheet, allowed by their SHA-256 hashes under `default-src 'none'` (no
`unsafe-inline`, no nonce). The heading's display face is inside that style sheet as a
`data:` font, the one thing `font-src` allows, so the page still asks for nothing. Everything that varies (words, the link) sits in the markup,
escaped, and the link must be one of the apps' schemes. The site's canvas link page
(`/canvases/<id>`) is the same pattern drawn in React with the site's components; it shares
the wait and the apps' names, and offers the Ponzu download only for a Ponzu link. The
Claude sign-in ends on claude.ai's own page (its code is pasted into Ponzu), so it leaves
no page of ours.

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
request, check run, check suite, review or push event makes the API read the pull request
of the canvas that owns its branch from GitHub again ("Pull requests", below), and a merge
settles the canvas. A failed check run or suite is an event with priority
`next` on that canvas's feed, and so is a submitted review by someone GitHub says can
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

**Opening a canvas** needs membership of its workspace and read access to its repo.
Steering it (messages, answers, merging) needs write access. Seeing a repo or its
canvases in a list needs the same read access: GitHub hides a private repo, its name
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
  (`GET /v1/workspaces/:id`), its canvases list and each renewal of `workspace.canvases`
  do it for one, when any answer about any of its repos is more than a minute old. A
  list GitHub cut short (past 2,000 repos) says nothing of the repos it left out, so
  the oldest of those whose answer a reader acts on (one that lets them read, or a
  repo with a canvas), up to 20 at a time, are asked about as the App.
- **A question, as the App.** `GET /repos/{owner}/{repo}/collaborators/{login}/permission`
  about one repo, asked by `requireCanvas`, `POST /v1/canvases` and a review's check
  when there is no fresh answer. It takes the answer only when the account it names
  has the person's GitHub id (a login can change hands). GitHub answers `read` on a
  public repo for anyone, so the list and the question agree.

While the App is not installed on a workspace, or is suspended, the answer for every
repo of it is `none` without asking GitHub: its canvases open for nobody (404), none
are listed, and no review reaches an agent.

The rules for reading it:

- An answer is taken as it is for a minute, so someone whose access is taken away
  loses it within a minute even if no webhook says so. Answers only replace older
  ones, so a slow request cannot bring back access a newer answer took away.
- Webhooks make it prompt. An access event syncs the person and writes their new
  answers at once; one that cannot (it names nobody, or their token is dead) makes the
  answers it concerns stale, so they are asked again before they are trusted, and a
  `workspace.canvases` subscription drops what it should at its next renewal.
- While GitHub fails or limits the API, the last answer stands for ten minutes. A
  stale one never does. After that what needed it is refused (`upstream_unavailable`);
  in `POST /v1/live` only that query is.
- An answer is about a member: whoever reads it also requires the membership, so
  someone who leaves a workspace loses its repos and canvases at once.

A Scratch canvas has no repo and is its owner's alone.

**The GitHub App** is the only way Ponzu touches GitHub. The API mints one-hour
installation tokens scoped to one repository and the least permission a job needs.
The private key never leaves the API.

## The document and how it syncs

A canvas is a `Doc` (pages, artboards, node trees, tokens, comment threads, notes).
Every change is an `Op`. This does not change. What changes is who orders the ops:
the API does, in Postgres.

### Committing

```
POST /v1/canvases/:id/ops     { ops: [{ id, op }] }
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
5. **Appends** it to `canvas_ops` with the next `seq` and bumps `canvases.seq`, in
   one statement that only succeeds if `canvases.seq` is still what the API read.
   On a miss it catches up and tries again. The same statement appends the events
   a person's ops make (see Events), so an op is never in the log without them, and
   copies the document's name and icon to the canvas's row when the ops changed
   them. The document is where the name lives: people rename with
   `PATCH /v1/canvases/:id`, which commits `file.rename` and `file.icon` as theirs,
   and the agent with `update_canvas`.

`id` is generated by the sender and unique within a canvas. Posting the same id
again returns the original result, so a retry is safe, for seven days. An op is
kept in the log, and its id with it, for at least that long whatever has been
checkpointed since; after that it may be pruned, and the same id would be appended
as a new op. A sender must not retry an op older than that. `seq` counts a
canvas's ops from 1 with no gaps; a canvas nobody has changed is at 0.

### Reading

```
GET /v1/canvases/:id/doc            → { doc, seq }
GET /v1/canvases/:id/ops?after=N    → { ops: CommittedOp[], seq }   (410 if N is too old)
```

The API rebuilds the current document from the latest checkpoint plus the ops after
it, and caches it per function instance keyed by `(canvas, seq)`. It writes a new
checkpoint after every 64 ops or 256 KB of op payload.

A page of ops holds at most 500 ops and 3 MB of them (always at least one), so the
answer fits in what a Vercel function may send; when the last op is below `seq`, ask
again from there. `GET /doc` streams instead: it writes the JSON text of `{ doc, seq }`
in 256 KB slices, and Vercel's 4.5 MB limit does not apply to a streamed answer, so a
canvas larger than that is still read in one request. A client reads it with `response.json()`
like any other answer. A refusal (no access, no such canvas) is decided before the first
byte and is the usual error body. The function still builds the whole document in memory
first, so its memory, not the answer's size, is what bounds a canvas; handing out a
checkpoint served from R2 is the way past that if canvases ever grow that large.

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

Neon Realtime carries small rows only. A canvas's content never travels through it.

Clients watch the canvas's head row (`seq`, agent state, pull request state). When
`seq` moves, the replica fetches the ops after its own `seq` from the API. That is
one push of a few hundred bytes and one HTTP read, and it keeps large op payloads
away from Realtime's row-size limit.

### Undo

Undo is the API's: `POST /v1/canvases/:id/undo` commits the inverse of the most
recent op by the caller or by the agent that has not been undone. `redo` reverses
it. Each op is stored with its inverse.

### Storage rules

- Node trees, ops and checkpoints are stored as `json`, never `jsonb`. `style` and
  `attrs` are ordered and `jsonb` reorders keys, which changes how CSS resolves.
- Node ids are not unique within a canvas. Nothing may key on them.
- Comment threads stay in the `Doc` and travel as thread ops, as today.

## Realtime

`packages/client` wraps Neon Realtime behind one module so it can be replaced.

- Clients never send SQL. They ask `POST /v1/live` for named queries with arguments
  (`workspace.canvases`, `canvas.head`, `canvas.thread`, `canvas.questions`,
  `canvas.presence`, `me`, `me.notifications`).
  The API authorizes each one and returns it sealed, with a 60-second lifetime.
- The endpoint takes a list, and clients renew all their subscriptions in one call.
- Live queries are plain filters and joins over small rows. Sorting happens on the
  client. Every watched table has a primary key.
- Presence is a row per person per open canvas, refreshed every 30 seconds and
  treated as gone after 75. It also says whether the person's window is focused on the
  canvas, which the API reads to hold back pings; `canvas.presence` does not carry that.
- `me.notifications` is the person's inbox ("Notifications"). Its filter is the predicate
  of the partial index `notifications_inbox_idx`, word for word, so Postgres reads it from
  that index, and a row leaves once it is read and, for a needs-you, resolved.

## The sandbox

One canvas owns one sandbox, one Claude session, one branch and at most one pull request. A
sandbox is a [Vercel Sandbox](https://vercel.com/docs/sandbox): a Firecracker VM, 2 vCPUs and
4 GB, in `iad1` beside the API's functions, booted from Ponzu's own image ("The image"), with one
public `https://<sub>.vercel.run` address for the runner's port. It is **persistent**: a stop
snapshots its disk (2 to 3 seconds for the image's 550 MB), and the next start boots a new VM
from that snapshot, so files survive a sleep and processes do not. Vercel has no idle detection
and no wake-on-request, so the API owns the lifecycle.

`packages/sandbox` is the one seam between Ponzu and Vercel: the `Sandboxes` type,
`vercelSandboxes` (on `@vercel/sandbox`, pinned exactly) and `FakeSandboxes`, which models
Vercel in memory with a clock the test controls. Nothing else imports the SDK
(`surface.test.ts` holds that).

- **One named sandbox per canvas.** A canvas's is `pz-<scope>-<canvas id>`, a Claude sign-in's
  `pz-<scope>-signin-<auth state id>`, and the live suites' and image checks' `pz-test-<tag>-<random>`.
  `scope` is the first 12 hex of a hash of the database URL (its host without `-pooler`, and its
  path), and nothing else: production's live sandboxes are named by that rule, so it never
  changes (`env.test.ts` pins it). Production's database is not dev's, so its scope is not
  dev's. Dev, previews and
  a local API on dev's Neon branch share dev's scope on purpose: they are the same rows, and dev's
  minute sleeps what a preview woke. Names are unique in the project, so the name is the
  idempotency key and the only handle the API keeps.
- **The scope is the wall between environments, and it is a check in our code.** Dev and
  production are one Vercel project, and Vercel Sandbox authenticates per project: an OIDC token
  belongs to one project ([Sandbox authentication](https://vercel.com/docs/vercel-sandbox/concepts/authentication)),
  and Sandbox's docs describe no limit by environment (the orchestrator's first dev deploy found
  Sandbox takes the `dev` environment's token), so dev's functions hold a token that could list,
  stop, delete and run commands in production's sandboxes. Nothing at Vercel stops that. What
  stops it is `packages/sandbox`: `vercelSandboxes` cannot be made without a scope, and it refuses any call (`up`, `status`, `list`, `start`, `exec`, `writeFile`, `readFile`,
  `extend`, `stop`, `remove`) whose name is outside its own `pz-<scope>-` prefix, and any listing
  that is not inside it or answers a name outside it, with the error `out_of_scope`, before a
  request is sent (`scope.ts`, tested call by call in `scope.test.ts`). The trailing dash is
  part of the prefix, so one scope's never begins another's. The live suites and image checks
  use the scope `test`, which reaches only `pz-test-` names. Reconcile checks each listed name's
  scope again, and logs `sandbox_out_of_scope` rather than act on one, so a listing someone
  widens later still never stops or removes another deployment's sandbox. This guards against a
  mistake in our own code; it does not stop code written to make a module for another scope,
  which is why the SDK is reachable only through this package.
- **Only `up()` resumes.** The SDK resumes a stopped sandbox on almost any call that needs a
  VM. So `up(name, spec)` is the one call that may, and every other call is pinned to one
  session (`At = { name, sessionId }`) and fails as `not_running` rather than wake anything:
  `start` (a detached command), `exec` (a waited one), `writeFile`, `readFile`, `extend` and
  `stop`. They go to Vercel's session endpoints, which never resume. `status` and `list` read
  without resuming, and `remove` deletes the sandbox and its snapshots.
- **`up()`** reads the sandbox without resuming it. Missing, it creates it. On another image
  digest it deletes it without booting it and creates it again (`recreated`). Its other settings
  (persistence, timeout, size, ports, snapshot expiry and count) are brought to the spec with
  `update`, which applies from the next session. Running, it answers that session
  (`wasRunning`); otherwise it resumes, which also absorbs a snapshot that expired (a fresh
  create). It answers the session's id, start and deadline, the port's address, and `fresh`
  when the disk is empty.
- **Errors** are six codes: `rate_limited` (a 429 the SDK did not wait out, with
  `Retry-After`), `busy` (from `up()` only: a create on a name a racing wake just took, or an
  image not ready), `not_running` (a pinned call on a session that is not the current one, or
  has stopped), `unavailable` (the network, or a 5xx after the SDK's retries), `rejected`, and
  `out_of_scope` (a name outside the module's scope: nothing was sent, and it is a bug, never
  retried).
- **Credentials.** On Vercel the API uses its function's OIDC token, and refuses a
  `VERCEL_TOKEN` there. Scripts, CI and the live suites use `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and
  `VERCEL_PROJECT_ID` (the ponzu-api project), all three or none. **The OIDC token is read from
  the request**, so the SDK is called only inside a request or in work handed to `waitUntil` from
  one (`deps.background`), never at module load or from a timer started outside a request. The
  cron is a request, so the sweep qualifies.

| Step | What happens |
|---|---|
| Create | On the first message, which `POST /v1/canvases` takes with the canvas (and a create key, so a double tap makes one). The API names the branch `pz/<topic>` from the message's first words that say something, numbered when taken, and never renames it. The first wake creates the sandbox from the image; the runner finds an empty disk, checks out the branch from the default branch (or makes Scratch's folder) and starts. |
| First run in a repo | Claude sets the checkout up itself. |
| Run | Ops go to the API as they happen. Commits go to the branch as they happen, and at the end of each turn the runner pushes whatever the agent left unpushed ("Git"). After each turn the runner saves a checkpoint: the session's transcript and the checkout's uncommitted work ("Saving the sandbox"). |
| Sleep | Five minutes after the last activity the API runs `ponzu-stop` (the runner finishes the turn's notice, flushes, reports, checkpoints and closes Claude Code; then `sync`), then stops the session, which snapshots the disk. |
| Wake | A message, answer or comment wakes it: `up()` resumes the snapshot on a new VM (wake to the runner's `/health` in 2 to 3 seconds) and the API runs `ponzu-start` with the runner's environment. A disk behind the last checkpoint is restored from it; then the runner resumes the Claude session, picks up a turn the last process left unfinished, and takes its pending events. |
| Settle | On merge the canvas settles and its sandbox is retired: stopped, deleted at Vercel with its snapshots, and its row deleted. |
| Fresh disk | A snapshot that expired (30 days after its last use; Vercel removes the sandbox 14 days after that), a new image, or a sandbox deleted at Vercel: the next wake boots an empty disk, and the runner rebuilds from the branch and restores the last checkpoint. The conversation and the uncommitted work come back; gitignored files do not. |

Waking is a job. The API records it in `jobs`, starts it with `waitUntil`, and a
one-minute cron finishes anything a function did not (`apps/api/src/sandboxes`).

Every kind of job is named in one registry (`apps/api/src/jobs/registry.ts`), one module per
area. Other work that must outlive its request and start at once records its job held and runs
it with `waitUntil` the same way (`runNow`). The minute's cron runs in steps
(`apps/api/src/cron/steps.ts`): the due jobs first, then the installation sweep, the sandbox
sweep and any other step (the pull request sweep, and once a day the orphan archive sweep), at
once. A step that throws is logged as `cron_step_failed` and the
others still run. A step runs every minute, once in every few minutes, or once an hour at a
given minute. One on a slot runs once in it however many runs overlap, and catches up within
five minutes when the run it was due in never came. A step that runs once a day takes an hourly
slot and does its work only in its hour.

On the hour, the retention step (`cron/steps/retention.ts`) deletes the rows that only keep
the service running: `auth_states` a day after they expire, finished `jobs` (completed or
failed for good) and `webhook_deliveries` 30 days after they finished or arrived, at most 5,000
of each a run, logging counts only. The periods are constants in
`packages/db/src/queries/retention.ts`, and the privacy policy states them. A step's slot
mark (`recordOnce`) is a finished job too, so it goes after 30 days: a `recordOnce` key must
name a window that is over well before then.

- **The database decides.** A canvas has at most one `sandboxes` row, keyed by the canvas, in
  one of four states:

  | State | Means |
  |---|---|
  | `asleep` | No session the row holds is running. `failure` says why the last wake gave up, when it did. |
  | `waking` | A wake job holds the row (`waking_by`): a create, a resume, or a restart in place. |
  | `awake` | A session is running, `ponzu-start` was sent with the row's runner token, and the row is metered (`awake_since`). |
  | `stopping` | A sleep is shutting the runner down and stopping the session, or a retire holds the row until its sandbox is deleted (`waking_by = 'retire:<job>'`). |

  Every move holds to the states it moves from and to the job holding the row, so of two
  function instances racing only one makes it, and another may take a held row over only once
  it has sat unmoved for six minutes. The row keeps the session it holds (`session_id`, and
  `session_started_at`, which a restart in place keeps), the port's address and its sealed
  bearer, the session's deadline, the runner token and which Claude credential it was started
  with. The canvas's head shows `waking` at once, and `agent_blocker` says why a canvas waits:
  `claude_not_connected`, `claude_expired`, `claude_owner_left` (whose Claude it runs on is no
  longer in the workspace), `sandbox_busy` (Vercel limiting the pace, or past the limits below)
  or `sandbox_failed`; and, from the wake gates below, `paused` (wakes paused while Ponzu
  updates), `credits_used_up`, `cap_reached`, `payment_failed` (the workspace at a billing
  limit) and `claude_limited` (the owner's plan at its limit). `agent_blocked_until` says until
  when, when a gate knows; the `canvas.head` live query sends both.
- **The wake gates** (`sandboxes/gates.ts`) are asked in order before the claim: `owner`,
  `claude`, `maintenance`, `billing`, `claudeLimit`. The first that refuses sets `agent_blocker`
  (and `agent_blocked_until` to the time it gave, if any), the rest are not asked, and the wake
  is over, or, when the gate gave a time, the same wake job is tried again then. A turn already
  running when `maintenance`, `billing` or `claudeLimit` refuses is left to finish, and the head
  still says the agent works. A wake that
  passes every gate lifts a gate's blocker the head still shows. When what a gate waited on
  changes, `resumeBlocked` lifts its blockers in a workspace, on a Claude account or
  everywhere, starts a wake for up to 20 of those canvases whose feed holds a `now` or `next`
  event (bringing forward a wake a gate had put off), queues the rest for the cron, and wakes
  nothing that owes nothing. `maintenance` refuses with `paused`, to be tried again in two
  minutes, while wakes are paused ("Security", the maintenance switch); `billing` lets
  everything through until its feature fills it; `claudeLimit` is "Claude plan limits". The
  runner's claim hands out only the kinds `claimableKinds` allows (every kind, except that only
  a stop, an edit and a push go out while the plan the canvas runs on is at its limit; billing
  will narrow it too); the rest stay in the feed,
  neither claimed nor delivered. A person's message, answer or create asks the request gates
  (`http/gates.ts`: `rateLimit`, `maintenance`, `billing`, in that order) once they are known to
  be allowed and before anything is written; `maintenance` refuses with 503 `maintenance` while
  Ponzu is read-only, and `billing` lets everything through until its feature fills it.
- **A wake** (`orchestrate.ts`) claims the row first:

  | Row | The wake |
  |---|---|
  | none | inserts it `waking`, under the limits |
  | `asleep` | moves it to `waking` |
  | `stopping` | waits for the stop to land (polling every second, up to 30 seconds), then as `asleep`; still held (a retire, a slow stop), it tries again later |
  | `awake`, started with the owner's current credential | nothing: the request's poke reached it |
  | `awake`, an older credential | moves it to `waking`: a restart in place |
  | `waking`, held by another wake | nothing |

  Then one path covers a create, a resume and a restart in place: `up()` on the canvas's image;
  if the session was already running (a restart, a session left running, a supervisor of an older
  runner), `ponzu-stop` in it; then `ponzu-start`, detached, with a new environment. The row moves
  to `awake` once the start is sent, and every runner token of the canvas but the new one is
  revoked; the runner claims by itself as soon as it is up, so the wake neither waits for
  `/health` nor pokes. Vercel limiting the pace, being busy or away, or the session ending between
  `up()` and the start, is waited out: the token is revoked, the session `up()` returned is
  stopped (so nothing runs between tries, which a resume of about two seconds undoes), and the job
  is tried again, from 15 seconds doubling to five minutes, or when Vercel said. Anything else, or
  about three hours of tries, stops the session the same way, moves the row to `asleep` with its
  `failure`, and shows `sandbox_failed`; the next message tries again. A wake whose row was taken
  from it after its `up()` (a retire, a repair) stops the session it started unless the row's
  holder now runs on it, and removes the sandbox when the canvas is settled or gone, since a
  retire that finished in between could not see what this wake made after it.
- **Limits.** Until billing exists, the claim also counts the sandboxes waking or awake in the
  canvas's workspace (`PONZU_SANDBOX_MAX_PER_WORKSPACE`, 5) and for its owner
  (`PONZU_SANDBOX_MAX_PER_OWNER`, 3), in the same statement; a wake past either waits as
  `sandbox_busy` and is tried again. The count is the statement's view, so claims for different
  canvases landing in the same instant can pass it by a few; it bounds the bill, it is not a quota.
- **The environment** is made new at every start (`environment.ts`): `PONZU_API_URL`,
  `PONZU_CANVAS_ID`, a runner token issued for it (hashed; good for 25 hours, longer than any
  session), `PONZU_PORT_TOKEN` (32 random bytes, the bearer of the runner's port, kept sealed on
  the row so the API can poke), `PONZU_RUNNER_BUNDLE` (the SHA-256 of the runner bundle this API
  serves, "The runner bundle") and exactly one Claude credential, the one the canvas runs on,
  opened from the vault. Beside them go the canvas's repo's secrets ("Repo environments"). It goes
  only into the env of the one `ponzu-start` command: never the sandbox's own env, which Vercel
  keeps and every command inherits, never a file. So a stopped sandbox holds no secret, and a
  secret changed later reaches a canvas at its next wake.
- **The image** is `apps/runner/image/current.json`'s `ponzu-runner@sha256:…`, which the API
  imports, so an image ships with an API deploy. A sandbox on another image is recreated on this
  one at its next wake ("How images roll out").
- **Sleep** (`stop.ts`, `putToSleep`). The runner's heartbeat while `working` (which it is from
  the moment it puts a message in, "Waking up" included), a turn the canvas is owed ("A turn that
  never came"), and anything a person does to the canvas keep the sandbox awake. Every sleep
  moves the row from `awake` to `stopping` (an idle one only if nobody kept it awake since it went
  idle, so a fresh message wins), runs `ponzu-stop` in the row's session (root, waited, 30
  seconds: the supervisor passes SIGTERM to the runner, which interrupts a running turn and says
  so in the thread, flushes its outboxes, reports its final state, saves a checkpoint and closes
  Claude Code, in 20 seconds at most; then `sync`), stops the session, revokes the canvas's runner
  tokens and moves the row to `asleep`, which meters the awake time. Then **the pending rule**:
  if the feed holds events no runner took, the canvas is woken again for them. Vercel's own stop
  sends SIGTERM too, with a grace it does not document (about 20 seconds measured), which is why
  the API runs the shutdown itself. A sleep that cannot stop the session leaves it running: the
  next wake's `up()` finds it running and shuts it down before it starts, and reconcile stops a
  session no awake row holds.
- **The session's own timeout** is the backstop: 30 minutes from its start, so a sandbox the API
  forgets stops by itself. The sweep extends an awake one by 20 minutes once its deadline is
  less than 10 minutes off, clamped so the session's whole timeout stays five minutes inside
  Vercel's 24-hour cap, and puts a session 23.5 hours old to sleep first (`cycle`, then the pending
  rule); while a turn is under way or owed it waits for the turn until the session is 23 hours 45
  minutes old, since a sleep cuts the turn. When the extend, or a restart's look at a runner
  unheard for 90 seconds, finds Vercel already stopped the session (its timeout), the row goes to
  `asleep`, its tokens are revoked and the pending rule applies: it is woken only for work.
- **Retire** (`retire.ts`) runs when a canvas settles, when a canvas is deleted while its
  account is kept, and when an account is deleted. It moves the row to `stopping` with
  `waking_by = 'retire:<job>'` whatever its state, which meters what was awake and turns away a
  wake that held it; revokes the canvas's runner tokens; stops the session if one runs; deletes
  the sandbox at Vercel with its snapshots; and only then deletes the row. A canvas reopened
  meanwhile finds its row `stopping` and its wake waits or tries again, so a late delete can
  never hit its new sandbox. A settle's retire, and the sweep's, take the row only while the
  canvas is still settled, so one that comes late (a sweep that listed the canvas before it was
  reopened) leaves the reopened canvas alone, and never from another retire inside its lease, so
  two never overlap; a retire that finds the row no longer its own deletes nothing at Vercel. A
  retire that dies leaves the row held, and the sweep runs it again once the lease is over.
- **The sweep**, every minute, never resumes anything: every call it makes reads or is pinned to
  the row's session. Each row gets the first step that applies, in this order:

  | Step | When | Does |
  |---|---|---|
  | retire | the canvas is settled | retire |
  | stop | its Claude can no longer run it, or its owner left the workspace | sleep (`claude_owner_left` shown for the second) |
  | restart | awake, and its runner unheard for 90 seconds | a session Vercel already stopped: `asleep` and the pending rule; otherwise sleep, then wake at once; after three in a row, sleep with `sandbox_failed`, not woken by the pending rule (the next message tries again) |
  | lapse | a turn it owes is past waiting for ("A turn that never came") | the thread says so and the event goes in again; an idle runner is poked, one that says it works is let go (its token revoked, so it writes no notice of its own) and slept and woken |
  | stalled | its runner says it works and has written nothing for an hour | the thread says so; the runner is let go, slept and woken |
  | sleep | idle for `PONZU_SANDBOX_IDLE_SECONDS` (300), owing no turn | sleep |
  | cycle | its session is 23.5 hours old (23.75 with a turn under way or owed) | sleep, then the pending rule |
  | extend | its session's deadline is less than 10 minutes off | extend, clamped |
  | repair | `waking` or `stopping` past its six-minute lease | take the row (only if nothing moved it since the sweep looked), stop a running session pinned to its own id, revoke its tokens; `asleep`; the pending rule |

- **Reconcile**, on minutes divisible by ten, lists this scope's names at Vercel and compares
  them with the rows, at most ten actions a run. A row waking or stopping inside its lease is
  left alone. A running sandbox is stopped, pinned to its own session, when its row is missing,
  asleep, or awake on another session (`sandbox_leak`), looked at again just before the stop so a
  wake that claimed it since the list keeps it; a name whose canvas was deleted is removed
  (an id never comes back); a settled canvas's is retire's. A sign-in's sandbox is removed once
  its sign-in is over or an hour old.
- **Disconnecting Claude** puts every awake sandbox started with that credential to sleep at
  once; an asleep one holds nothing and is left alone. One waking at that moment is put to sleep
  by the sweep's `stop` within the minute.
- **Logs.** `sandbox_awake` (with `start`, `fresh` and how long), `sandbox_stopped` (why, the
  snapshot's size, how long), `wake_failed`, `wake_let_go`, `sandbox_expired`, `sandbox_repaired`,
  `sandbox_retired`, `sandbox_retire_skipped`, `sandbox_leak`, `sandbox_orphan_removed`,
  `sandbox_out_of_scope` (an error: a listing answered another scope's name, which reconcile
  left alone), `runner_dead`.

### The runner

`apps/runner` is one long-lived process per sandbox. It:

- runs Claude Code through the Agent SDK, one session per canvas, with the repo's
  own `CLAUDE.md`, skills, hooks and MCP servers;
- hosts the canvas tools in-process as an SDK MCP server. The tools work on a
  `Replica`, so they read the document synchronously and their ops stream to the
  API in the background;
- keeps one Chromium for `screenshot`, `record`, `export`, measuring and lint, next
  to the repo's dev server;
- writes the thread (assistant text, tool steps, questions) to the API as it goes;
- reports state: working, what it is working on, needs you, idle.

The runner dials the API with a token that is valid for one canvas. The API reaches
the runner through the sandbox's public address for its port, with that port's bearer, to say
there are events to claim ("The runner protocol" below).

How Claude Code is configured, and why (`apps/runner/src/agent/sdk.ts`):

- **One session, one process.** One `query()` per canvas, fed through an input queue so the
  Claude Code process stays up between turns, and resumed by session id when the runner
  starts again. The session's transcript lives on the sandbox's disk
  (`~/.claude/projects/<cwd>/<session id>.jsonl`), which a stop keeps, and in each checkpoint,
  which brings it back to a disk that lost it ("Saving the sandbox"). A session whose transcript
  is gone from both starts over. The SDK is pinned to the version
  released with the image's Claude Code (the same patch number; "Keeping Claude Code current"
  moves both), and runs the image's
  `/opt/ponzu/claude/<version>/claude` (checked against the SDK manifest's hash), never a copy
  of its own.
- **Nobody to click "allow".** `bypassPermissions`, as `agent` in a VM of its own.
  AskUserQuestion, plan approval and any other prompt still reach `canUseTool`, and become
  questions ("Needs you"). That AskUserQuestion does so under `bypassPermissions` is what the
  SDK documents and the runner's tests assume; the live proof is the "Needs you" case in
  `apps/runner/src/live.test.ts`, which has not been run yet. If it fails, AskUserQuestion is
  taken out of the bypass for that tool alone. An MCP server's elicitation reaches
  `onElicitation` ("Needs you"). The result message is the only success signal: an API failure
  arrives as `subtype: "success"` with `is_error: true`.
- **The repo's own Claude Code.** `settingSources: ["project"]` loads the repo's CLAUDE.md,
  `.claude/settings.json` (hooks, permission rules), skills, commands and agents; the sandbox
  user's own settings do not load.
  `strictMcpConfig` is on and the runner passes the repo's `.mcp.json` servers itself, beside
  `ponzu`, so they start without an approval prompt nobody could answer. A hostile repo can
  therefore do anything as `agent` that its code could: reach the Claude credential, a token
  for its own repository and its own secrets. Not the runner token, nothing of another canvas.
  So can anyone who talks the agent into it ("Security": prompt injection).
- **Ponzu's part.** `CLOUD_INSTRUCTIONS` and a line on the checkout are appended to the
  `claude_code` system prompt. The canvas tools are the in-process MCP server `ponzu`,
  always loaded rather than behind tool search, each tool's `ToolDef` mapped to the SDK's
  form once and its screenshots returned as images.

### The canvas tools

`packages/tools` has the tool set (`cloudTools`), its guides (`cloudGuides`,
`CLOUD_INSTRUCTIONS`) and what the runner hosts them on: `createCloudWorkspace`
builds the workspace for the sandbox's one canvas from the `Replica`, the renderer
and a handful of callbacks (`CloudHost`) for what leaves the process: the agent's
status and the artboards it is on, the intent of a request, storing an asset,
publishing an export, the canvas's link and the theme to render in.

- **One canvas.** No tool takes a file and none manages files. `update_canvas`
  sets the canvas's name and icon. A new canvas starts with one empty page
  (`POST /v1/canvases` makes it); a canvas may still come to have none, and
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
  turn and before the sandbox sleeps the runner waits on `canvas.settled(timeout)`,
  which keeps the replica retrying for as long as it waits, and gives the agent
  any notice no tool result carried.
- **Other people's ops** reach the same in-process event and presence hubs the
  agent's own do, so a board a person deletes stops showing as worked on.
- **Files go by sandbox path.** A canvas is not a folder of files. HTML too long for one
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
  which the sandbox image installs from where playwright-core's installer would
  fetch it, by hash. Its version moves with our lockfile, and on a small sandbox it idles at 140 MB and draws a landing page in 0.4 s, where
  a full Google Chrome takes 290 MB and 0.9 s.
- **Chromium's sandbox stays on.** The runner is not root, and the VM allows user
  namespaces. A canvas can load remote images in the same machine that holds the
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
- **Fonts.** Canvases name fonts a Mac has and Ubuntu cannot ship: Helvetica, Menlo,
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
  font for it, which fallback draws at Noto's line height where the board's CSS sets
  none. Fallback goes by what is installed, so the image holds the fonts in that
  list and no others for those scripts.
- **The dev server.** With `loopback: true` a canvas can load images, video, fonts
  and stylesheets from `http://localhost:<port>`. Chrome refuses those to a page at
  a public origin, so the renderer grants its pages Chrome's permission for this
  machine, and only this machine: the rest of the local network stays refused.
  Chrome then loads them itself. A request that needs a CORS header a dev server
  doesn't send (every font, a mask image) is fetched by the renderer instead, which
  holds the file whole on its way to Chrome and so refuses one over 25 MB.
- **Bun.** The runner runs on the Bun this repo pins, which the image installs.

### The image

Every sandbox boots from one container image, built from `apps/runner/image` (its README has
what is in it and how it is checked): `ubuntu:24.04` by digest, the Bun this repo pins, the
Claude Code the Agent SDK pin speaks to (checked by the binary's hash), the Chrome Headless Shell
playwright-core pins (checked by the zip's hash) and `playwright-core` itself, exactly
`packages/render`'s fonts at the versions it pins, `tmux` for the Claude sign-in, the three
users, and the two commands the API runs, `ponzu-start` and `ponzu-stop`. It holds no runner:
the runner comes from the API at a start ("The runner bundle"). Vercel runs nothing of the image
at boot (no ENTRYPOINT, no CMD, no init).

`apps/runner/image/build.ts` builds it for `linux/amd64`, pushes it to the **ponzu-api project's
Vercel Container Registry** as `ponzu-runner:<the first 12 hex of its inputs' hash>`, waits for
the registry to say it is ready, runs `checks.ts` in a `pz-test-image-*` sandbox from its digest,
and records it in `current.json`. The inputs are the Dockerfile, `provision.sh`, `pins.json` (the
one source of every pin), the font manifest and `libexec/`; a tag the registry has is not built
again. `.github/workflows/image.yml` does the same for pushes that touch them and opens a pull
request with `current.json`; Claude Code and the Agent SDK are moved by their own workflow
("Keeping Claude Code current"). A registry repository belongs to one project, so the short
`ponzu-runner@sha256:…` resolves for the API's OIDC token and for scripts using the ponzu-api
triple. `image.test.ts` fails when `current.json` is stale for the inputs, when its pins are not
`pins.json`'s, or when the runner bundle needs another Claude Code or playwright-core than the
image has. About 550 MB.

**The image commands**, root-owned and run as root (`runCommand({ sudo: true })`):

- `ponzu-start`, detached, at every start: when the disk does not have the bundle
  `PONZU_RUNNER_BUNDLE` names, fetches it from `GET /v1/runner/bundle` (the runner token on curl's
  stdin, never an argv), checks its SHA-256 and that its `manifest.json` fits the image's
  `image.json`, and unpacks it into `/opt/ponzu/runners/<sha256>/`, keeping the newest three; a
  wrong hash or a bundle that does not fit exits 78. Then
  `flock -n /run/ponzu-supervisor.lock bun supervise.js`, so a start sent twice runs one
  supervisor. Its output, and the runner's, goes to `/var/log/ponzu/runner.log` (0640
  `root:ponzu`), so **Vercel's command log for the start holds only the script's own lines**:
  Vercel keeps a command's output, and nothing of the runner's belongs there.
- `ponzu-stop`, waited, before every stop: SIGTERM the supervisor, wait up to 25 seconds for its
  lock, `sync`. With no supervisor running it only syncs.

**The supervisor** (`apps/runner/src/supervise.ts`) is what keeps the runner running in a VM
with no service manager. It reads `/opt/ponzu/runner.json` (where things are, and the runner's
variables that are not secret), makes `/run/ponzu` for the git credential socket, and starts
`runner.js` as `ponzu` (group `agent`, umask 002, `CAP_DAC_READ_SEARCH` to read Claude Code's
0600 transcripts). It restarts a runner that fails, after 1, 2, 4 … up to 30 seconds (reset after
a minute up), and stops for good when it exits 0 or 78: the environment is wrong, the token was
revoked (the canvas was deleted or settled), or a newer runner took the canvas's lease; only a
new start mends that. It passes SIGTERM, SIGINT and SIGHUP to the runner, and kills what is left
of its group once it has exited or after 20 seconds.

**Three users.** `ubuntu` is the user Vercel's commands run as, with sudo
(`Defaults:ubuntu always_set_home, !env_reset`, without which sudo drops a command's env and the
runner would start without its environment). The runner runs as `ponzu`, whose only sudo is to
become `agent`. Claude Code, its tools, the repo's hooks and the checkout's git run as `agent`,
which has no sudo and no way into `/home/ponzu`, `/var/log/ponzu` or the supervisor's and
runner's `/proc`, so nothing the repo or the agent runs can read the runner token or the port's
bearer (`as-agent` unsets both whatever its caller passed). git asks the runner for credentials
over a socket ("Git"). The canvas tools run in the runner's process, so a file the agent names
to one (an HTML file by path, an asset, an export) is read and written as `agent`
(`PONZU_AS_AGENT`): a path, or a link a repo committed, reaches only what the agent could reach
itself, not the runner's environment or home. The Claude credential is still in the agent's
environment: Claude Code needs it.

### The runner bundle

`apps/runner/scripts/build.ts` builds `dist/`: `runner.js` (everything but playwright-core,
which the image has), `supervise.js`, `git-credential.js` and `manifest.json` (the Claude Code
and playwright-core it needs, from its own dependencies), packed into `runner.tgz` the same way
every time (sorted entries, fixed times), and `bundle.json` with the tgz's SHA-256. The API's
build (`apps/api/scripts/build.ts`) runs it and inlines the bundle into the function
(`@ponzu/runner/bundle`), so **a runner change ships with an API deploy**, with no image change.
`GET /v1/runner/bundle` (runner token) answers the tgz with `x-ponzu-bundle-sha256`, and the API
names it in every start's `PONZU_RUNNER_BUNDLE`. A local API needs `bun apps/runner/scripts/build.ts`
once; without `apps/runner/dist` a wake fails saying there is no runner bundle.

### How images roll out

A canvas's sandbox, once made, sleeps and wakes on its own disk. A canvas moves onto the image
the API ships the next time it wakes after that deploy (`imageFor` in `orchestrate.ts`), with no
one doing anything: `up()` sees another digest, deletes the sandbox without booting it, and
creates it on the new one. The runner finds an empty disk and rebuilds, restoring the last
checkpoint ("Saving the sandbox": the transcript, the work in progress and its unpushed commits),
and resumes the same Claude session, with the message that woke it waiting in the feed. The head
says `waking` throughout and the thread says `resumed` as after any wake; `sandbox woke` says
`recreated`. What it costs: a create and a rebuild in place of a resume, a few seconds, and the
gitignored files (`node_modules`, a build), which a build makes again. Only an OS, font, Bun,
Claude Code or headless-shell change makes a new image; the runner itself ships in the bundle.

**What is recorded.** `sandboxes.image` is the image the row's sandbox runs. `canvas_runners.client`
is what the runner holding the lease said it is as it took it (`runner/<version>+<bundle>`), and
the API logs `runner_started` with both. `sandbox woke` carries the image, `turn finished` the
runner and its bundle, and the runner puts `ponzu_runner` on each of its traces.

**When it waits.** A recreate loses the disk, so it happens only when the last checkpoint holds
everything that went into the session. Otherwise the wake resumes the sandbox on its own image,
logs `sandbox_move_held` with why, and the canvas moves at a later wake:

| Why (`reason`) | What happens next |
|---|---|
| it is awake or getting there | nothing: an awake sandbox is never recreated, so no turn is ever cut. It moves at the first wake after it next sleeps. |
| `checkpoint_behind`: an event went into the session after the last checkpoint was recorded (`canvas_runners.saved_through` against the delivered events' `seq`; a `stop` or a `push`, which never go into the session, does not count) | it wakes on its own image, its runner saves after its next turn and at the sleep, and the wake after that moves it |
| `no_checkpoint`: its runner never saved one | it stays: a recreate would lose its conversation and what is only on its disk |

**When: at the wake, not ahead of it.** A sweep that recreated sleeping sandboxes as soon as an
image ships would start every sleeping canvas's runner on its owner's Claude credential while
nobody asked, including canvases nobody opens again; at the wake the person sees the same waking
state either way.

**How long an older runner can be out there.** A runner talks to the API only while its sandbox
is awake, and every start runs the bundle the API serves now. So the API must work with the
runner of the deploy before it only until the sandboxes awake across that deploy next sleep.

```sh
bun apps/api/scripts/images.ts   # where each canvas stands against current.json; DATABASE_URL, or NEON_* for dev
```

`packages/client/src/image-move.live.test.ts` checks a recreate end to end, by hand, across a
deploy.

### Keeping Claude Code current

Two pins move together: the Agent SDK in `apps/runner/package.json` (exact, with `bun.lock`) and
Claude Code in `pins.json` (version, the linux-x64 binary's URL and its SHA-256). The SDK names
the one Claude Code it is released with (`claudeCodeVersion` in its package, the same patch
number), and the runner refuses an image whose Claude Code is not that one. Models are not
pinned in the image: an account is offered what the image's Claude Code reports for it
("Models"), so a new model is usable once the image's Claude Code knows it and a runner on that
image has reported. `CLAUDE_MODELS` in `apps/api/src/claude/models.ts` is only the fallback
offered before a report, and the names and order of the models it knows.

**The bump pull request.** `.github/workflows/claude-code.yml` looks for an Agent SDK newer than
the pin (`apps/runner/image/bump.ts`), daily, from `main`. When there is one, and the open pull request does not already propose
it, it:

1. takes the Claude Code that SDK names, and stops, saying so, if their patch numbers differ;
2. checks the release's `manifest.json` against its signature by Anthropic's release key (by
   fingerprint, as code.claude.com/docs/en/setup publishes it), downloads the binary and checks
   its SHA-256 and size against that manifest and the SDK package's own copy of it, and writes
   `pins.json`; `bun add --exact --ignore-scripts` moves the SDK;
3. typechecks and runs the runner's agent tests with the new SDK;
4. builds, pushes and checks the image through `image.yml` (its checks include a Haiku turn) and
   records `current.json`;
5. runs a real turn on that image (`e2e.ts scratch`: Haiku at low effort on the development key,
   a create and two sleeps and wakes);
6. opens or updates one pull request, branch `claude-code/bump`, with a table of what passed,
   the release notes of both since the pinned versions, and any model they name that Ponzu does
   not offer, then dispatches CI on it. Anything that did not pass makes it a draft whose first
   line says what; a run whose setup is missing says which steps could not run and why. Nothing
   merges it.

What it proves: the pair is the one Anthropic released together, the binary is the signed one,
the runner still compiles against the new SDK, the image builds and passes its checks, and a
real turn works end to end on it. What it does not: behaviour that only a person's canvases,
repos or other models exercise, which the release notes are for.

**Reviewing it.** Read the notes for anything that touches how the runner drives Claude Code
(permissions, hooks, sessions, the SDK's options and messages in
`apps/runner/src/agent/sdk.ts`). A failed typecheck means the SDK's API changed: fix the runner
on the branch. While its pull request is open with a commit the workflow did not make, the
workflow leaves the branch alone, so a newer release waits until it is merged or closed; it
also leaves the branch alone if it moved while the run built and checked. A pair already on the
branch is not built again, even when its pull request was closed or could not be opened; the
run warns, and a dispatch with `force` builds it and opens the pull request again. A
failed check or turn with a passing typecheck means Claude Code behaves differently: the log in
the body says where. To offer a model the notes name, add it to `CLAUDE_MODELS`. Merging ships
the image with the next API deploy, and each canvas moves to it at its next wake ("How images
roll out").

#### Setting up the image workflows

`image.yml` and `claude-code.yml` need these, once, from a person. Until the first two and the
fourth are set they pass with a warning that names what is missing, and the bump pull request
opens as a draft saying which steps did not run. A registry login that fails (the third, or the
registry being down; the run cannot tell which) is a red run.

1. The repository variables `VERCEL_TEAM_ID` (the team's `team_…` id) and
   `VERCEL_API_PROJECT_ID` (ponzu-api's `prj_…` id). `deploy-api.yml` reads the same two; on
   2026-11-11 neither was set on the repository.
2. The repository secret `VERCEL_TOKEN`: a Vercel token for the team, able to use ponzu-api
   (`deploy-api.yml`'s dev job reads the same name from the GitHub Environment `dev`; its
   production job reads only `VERCEL_TOKEN_PRODUCTION`). It reads the registry, and makes and
   removes the `pz-test-*` sandboxes of the checks and the turn. Dev and production are one
   project, so mint it from a member with the Developer role and without Full Production
   Deployment ([production.md](production.md), "The production deploy, staged").
3. A Container Registry OIDC policy on ponzu-api giving `north-brook/ponzu` read-write, so
   `vercel/vcr-action/login` can push (Vercel's docs: container-registry/github-actions).
4. The repository secret `ANTHROPIC_API_KEY`: the development key. Without it the checks only
   claim a message and the bump's real turn does not run.
5. Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"
   on. It is off, so neither workflow can open its pull request yet (each still pushes its
   branch and says so). Their pull requests then get CI by a dispatch of `ci.yml` on the
   branch, with no token of a person's.

Then dispatch the Claude Code workflow once on `main` with `pretend` set to an SDK version
before the pinned one (`gh workflow run claude-code.yml --ref main -f pretend=0.3.<n-1>`): it
runs every step and writes the body it would open into the run's summary.

### Saving the sandbox

Two things used to live only on a sandbox's disk: the checkout's uncommitted work and Claude
Code's transcript of the session, which is the conversation's memory. And the disk is a cache:
its snapshot expires after 30 days unused, a new image recreates it, a sandbox can be deleted at
Vercel, and a host can be lost under a running one. So the runner checkpoints both, the API keeps the checkpoint, and a runner that finds its disk behind
it restores before Claude Code resumes (`apps/runner/src/save/`).

**A checkpoint** is saved after each turn has settled, and in the runner's shutdown before every
stop (`ponzu-stop`, above):

- **The transcript.** What makes a session resumable is `projects/<cwd, every other character a
  dash>/<session id>.jsonl` under Claude Code's config folder (`CLAUDE_CONFIG_DIR`,
  `/home/agent/.claude` in the image), and the folder of the same name beside it when there is
  one (subagents' transcripts, tool results kept out of the main file). Nothing else under the
  config folder is needed to resume. They are packed with `tar -z` run as the agent (they are
  0600 `agent`), at most 64 MB compressed. One past that is left out of the checkpoint, which
  still saves the work and keeps the transcript stored before (`keep`, below); the thread says
  once that the conversation is no longer being saved, and the runner logs
  `checkpoint_session_skipped`.
- **A repo canvas's work in progress** is a commit whose parent is the checkout's HEAD, so
  commits not yet pushed travel with it, and whose tree is the working tree with untracked files
  and without ignored ones, built in an index of its own (the checkout's index, branch and stash
  are never touched). It goes nowhere on GitHub: a git bundle of it, holding only the commits
  GitHub does not have (it leaves out what `origin/<branch>` and `origin/<default branch>` hold),
  gzipped, is the checkpoint's `workspace` archive, stored like a transcript (below). A ref on the
  repository was the first canvas and was dropped: everyone who can read the repository can
  fetch a ref (on a public one, everyone), GitHub keeps a force-pushed commit reachable by its
  hash, and every other canvas's agent on the repository can write it. The commit stays on a
  local ref in the checkout (`refs/ponzu/wip/<canvas id>`), which nothing pushes.
- **A Scratch canvas's files** are a `tar -z` of its folder (`node_modules` and `.git` left out).
- **What is left out**, of both: a file over 5 MB, or past 50 MB in all; a file whose name says it
  holds a secret even when the repo does not ignore it (`.env` and `.env.*` but `.env.example`
  and its kind, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa` and its kind, `.npmrc`, `.netrc`,
  `.pypirc`, `.git-credentials`, anything under `.aws/`, `.ssh/`, `.gnupg/`, `.docker/` or
  `.kube/`); and a file that holds the value of one of the repo's secrets or the Claude
  credential (8 characters or more). The commit message names each, with why (`Ponzu-Skipped`).
  The next sandbox's environment brings the secrets back; nothing else would need them.
- **The marker.** Each checkpoint carries a turn marker one above the highest the runner knows.
  The API records it only over a lower one (`canvas_runners.saved_*`), so a late or repeated call
  never puts an older checkpoint back, and the runner keeps the marker the API confirmed on its
  disk, flushed (`~/.ponzu/checkpoint.json`). Before it sends one it writes the marker again with
  the turn it is sending as `pending`: a marker one behind the API's that says that turn is
  pending is a stop that came between the API's answer and the write, logged `marker_lag`, not a
  rollback. Nothing is saved when nothing changed since the last.
- **Never less than the last.** A part a checkpoint cannot carry (a transcript too large or not on
  this disk, work that could not be saved or did not change, a checkout that could not be had)
  is kept from the checkpoint before (`keep`), with its session id or commit, so a checkpoint
  never drops what the one before it held.

**At start**, once the folder is ready and before Claude Code reads its transcript, the runner
compares its marker with the API's (`RunnerSession.saved`):

| Disk | Means | Does |
|---|---|---|
| the same or newer | nothing was lost | nothing; work done since the last checkpoint stays |
| one behind, that turn `pending` | the marker lagged (`marker_lag`) | confirms the marker |
| none | a new sandbox (`rebuilt`) | restores from the checkpoint |
| older | the disk went back (`rollback`) | restores from the checkpoint |

Restoring never puts something older over something newer. A transcript or a Scratch file that is
newer on the disk than in the archive is kept (a transcript only grows). The work in progress is
the commit the API recorded and only that: it comes from the recorded archive (whose size and
SHA-256 the runner checks, and whose bundle must carry that commit and be built on commits the
checkout has), never from whatever a ref holds. It goes back only where it loses nothing: the
branch is moved to the saved HEAD when the saved HEAD contains it (`merge --ff-only`), or when the
branch is one this disk only just made (never pushed, nothing of its own beyond the default
branch, which may have moved on since: the common case of a young canvas on a busy repository);
when the branch was pushed and has moved on past it, the work is put on a local branch,
`ponzu-wip/turn-<n>`, and the thread says so, for the agent to bring over what the person wants.
Changes the disk has of its own are put in `git stash` first, never thrown away. The index is
left as HEAD has it, so what was uncommitted is uncommitted again and what was untracked is
untracked. Then the session resumes, and the thread says `resumed` as after any wake. The runner
logs `sandbox_rollback` (or `sandbox_rebuilt`) with both markers, the boot ids and how long the
restore took, and tells the API (`POST /v1/runner/restored`), which logs it with the sandbox's session and image.
With one snapshot kept per sandbox a rollback should not happen; the check is the same one that
finds a disk lost with its host.

**Where it is stored.** A transcript holds the whole conversation and every tool's output, and a
bundle the person's unpublished work, so neither goes under a canvas's asset key, which people
hold and the assets domain serves. Archives are uploaded through the uploads protocol (purposes
`session` and `workspace`) to `private/<32 random characters>/<upload id>-<name>`, a key no
answer to any client carries, stored `Cache-Control: private, no-store`, recorded only by `POST
/v1/runner/checkpoint` (completing one as a file is refused, since it would answer an assets
address), read back only through a ten-minute signed GET handed to the canvas's runner, deleted
when a later checkpoint replaces it, and deleted with the canvas (deleting it, or deleting the
account of the person whose canvas it is alone), recorded or not. They go to their own store,
`deps.archives`: **set `R2_PRIVATE_BUCKET` before production**, a bucket on the same account
with no public domain, and they go there; unset (as on dev), they go in the assets bucket, where
the random key is all that stands between a transcript and the world, since the assets domain
serves any key it is asked for. A settled canvas keeps its last checkpoint, so that reopening it
resumes the conversation.

**Archives nobody records.** No bucket lifecycle rule may touch `private/`: a rule goes by age
alone, cannot tell a recorded checkpoint from an unrecorded one, and would delete the last
checkpoint of every canvas settled for a day. Only `staging/` and incomplete multipart uploads
take a bucket rule. The API deletes the rest itself: the archives a later checkpoint replaces,
those of a deleted canvas, and, once a day, the ones nobody records. That last is the cron step
`archives` (`apps/api/src/cron/steps/archives.ts`), at 09:41 UTC. It lists `private/` in
`deps.archives` (ListObjectsV2, which gives each object's time) and deletes the objects over a
day old that no `canvas_runners` row names as its transcript or work in progress, asking the
database after the listing: an upload whose checkpoint call never came, and one whose delete
failed. It deletes at most 2,000 a run and reads at most 50 pages of a thousand keys, starting at
a random key and going round, so a bucket larger than one run reads is still swept whole over
the days. It keeps an object storage gives no time for, deletes nothing when the database does
not answer, and logs `archives_swept` with counts only (listed, recorded, young, undated,
deleted), never a key. So that it can never race a checkpoint, `POST /v1/runner/checkpoint`
refuses an archive whose upload address ran out more than twelve hours before (404), and the
runner saves anew.

### Events

A canvas has one ordered feed of things that happened: a message, an answer, a
comment, an edit by a person, a failed check, a review.

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

### A turn that never came

An event is acknowledged once the Claude session holds it, and from then on no claim hands it
out again. That leaves one way to lose it: the session holds the message and the turn it began
never finishes, because the process was killed under it (a sandbox stopped under a turn that had
just begun), or Claude Code died, or the turn hung. A resumed Claude Code whose transcript ends on a message it never
answered waits for another; the next runner finds the message in the session and has nothing to
deliver. The person was left looking at their own message, with no working line and no error,
and the sweep put the sandbox to sleep on top of it. Two things now see to it, and either alone is
enough.

**The runner picks it up** (`apps/runner/src/inflight.ts`). When Claude Code takes a message in,
the runner writes what it took (its uuid and event, and the event that began the turn) to
`~/.ponzu/turn.json`, flushed, and clears
it at the turn's result, unless its own shutdown cut the turn off. A runner that starts (or starts
Claude Code again after it died) and finds it, with the resumed session holding that message, says
so in the thread (`turn_failed`, "Claude was cut off before it finished this, and is picking it
back up"), puts in a word to the agent that its last turn was cut off and to carry on, and reports
`working` at once. A turn is picked up twice at most; the third time the thread asks the person
to send it again. A message the session does not hold was never delivered, and the claim brings it
back; a session that is gone is the API's to send again. A turn the runner interrupts to sleep
says so already and is not picked up. And a turn in which Claude Code says nothing at all for 20
minutes (no stream, no tool's result, no subagent's step: past its own ten-minute limits on a
request and on a command) is stuck: the runner interrupts it and says so, and if it is still
stuck a turn later, starts Claude Code again. A long turn's item is written again every five
minutes while Claude Code is busy, so the API sees it go on.

**The API notices it, whatever the runner** (`apps/api/src/sandboxes/sweep.ts`). A runner thread
write that says anything of a turn (the agent's text, a turn's work, a question, a stop, an error
of a turn; not `waking`, `resumed` or `started`, nor `clone_failed` or `push_failed`) moves
`canvas_runners.said_at` on, and so does a usage report of a finished turn (`POST
/v1/runner/usage` with a `turn`), which every runner sends, so a turn that answered without
writing anything is not taken for one that never came. An event that begins a turn (`message`,
`answer`, `comment`, `check`, `review`, priority `now` or `next`) delivered after it is owed one,
by the API's clock, which `delivered_at` and `claimed_at` are now kept by too, unless a person's
stop came after it: a turn stopped while it was starting writes nothing, and is not sent again. While a canvas owes a turn its sandbox is not
put to sleep. The owed events lapse when the runner says it is not working for two minutes, or
says it is but has written nothing for fifteen, both counted from the newest delivery or from when
the runner that holds the lease started, whichever is later, so a fresh start or a long session's
resume has its own time. Two minutes is many times what a runner takes to write a turn's first
item once the model's first token is in, which comes before it would report idle; fifteen is
past the slowest first output of a model on a long session. A lapse marks the events
(`events.lapsed_at`), writes an error notice in the thread under the newest one's id
(`ti_lapsed-<event>`: "Claude was cut off before it answered this, so Ponzu is sending it
again."), and puts each in the feed again as a copy under a new id with `payload.retryOf`
naming it, which the next claim hands out and every runner, old or new, puts into the session as
a message it has not seen. A copy that lapses too is not copied again: the thread says to send it
again. The sweep then pokes an idle runner, or, for one that said it was working all along,
puts the sandbox to sleep and wakes it again, so a new runner and a new Claude Code take the
copy. A runner that says it is working and has written nothing of the turn for an hour is stuck
the same way: the thread says so (`ti_stalled-<runner>`) and the sandbox is slept and woken. Each lapse is logged
(`turn_lapsed`: the events, the copies, the agent's state, how long since the delivery, the
runner's start, its last word and its last report) and captured (`turn lapsed`, `turn
stalled`). A runner that is picking up a turn acknowledges the API's copy of it without putting
it in. Everything delivered before this was deployed counts as answered (the migration sets
`said_at`).

### Needs you

When Claude asks a question, wants a secret, or hands off a link, the runner writes
a question row. Every client shows it in the composer, the canvas's row shows a
count, and the phone gets a push. An answer is an event with priority `now`.

Who hears of it, and when, is in "Notifications": the owner and whoever is driving the canvas at
once, everyone else who can steer it and has opened it five minutes on if nobody has answered.

A question outlives the sandbox's sleep. The API keeps a sandbox awake only while its
runner is `working`, so one that waits on a person sleeps after five minutes; its question
stays open, the canvas stays `needs_you`, and the answer wakes the sandbox and goes into
the resumed session as a message that says again what was asked. A question is withdrawn
only when the run moves on: a person stops the turn, or the turn ends, or the next turn
ends for one an earlier run left open.

Questions are rows that clients watch, and neither they nor events are encrypted.
The answer to a request for a secret is therefore not the secret: the API encrypts
the value into the repo's secrets, and the question and the event carry only the
secret's name. A Scratch canvas has no repo, so it has nowhere to keep one.

**A secret the agent asks for.** On a repo canvas whose checkout is there, the runner hosts
`request_secret({ name, description })` beside the pull request tools. The name is checked by
the same rule as Settings (`checkSecretName` in the runner protocol, which the API and
`newEnvironment` use too) before anyone is asked. The runner raises a `secret` question under
the tool call's id (`q_` from it, so raising it again is safe) and waits on it as on
AskUserQuestion; the thread's step says "Asking for NAME", then "Asked for NAME". Anyone who
may steer the canvas answers it with `POST /v1/canvases/:id/questions/:questionId/secret
{ value }` (1 byte to 16 KiB, no NUL): 409 `question_closed` once answered or for another kind,
409 `no_repository` on Scratch, 400 `secret_name_reserved`, and 409 `secrets_full` past the
repo's 50 secrets or 44 KiB (a replacement counted as one). One statement seals the value into
`repo_secrets`, closes the question with `{ name }` and writes the `answer` event
`{ questionId, question, secret: { name } }`; the route captures `question answered` (kind
`secret`) and `repo secret changed`. The runner of the turn that asked then fetches the value
with `POST /v1/runner/secret { questionId }`, which answers `{ name, value }` once
(`questions.delivered_at`), within 15 minutes of the answer, to the runner holding the lease,
and 404 otherwise. That is the privilege the start's `PONZU_REPO_SECRETS` already gives, for one
value. The runner writes it as the agent to `~/.ponzu/secrets/NAME` (0600, outside the checkout
and the transcript, so no checkpoint holds it), adds it to what the log, the thread, the state,
traces and checkpoints scrub, and the tool says: "NAME is saved to this repository's secrets in
Ponzu. It's in the file ~/.ponzu/secrets/NAME now, and in the environment of every command from
the sandbox's next start. Never print it." Each start empties that folder: its environment has
the repo's secrets as they are then. An answer that comes after the turn ended goes in as a
message that names the secret and says it is there from the next start.

**A link handed off.** An MCP server's URL elicitation (`onElicitation`, `mode: "url"`) with an
http or https address becomes a `handoff` question `{ title, url, description }`, which the
apps show as "Open …" and "Not now". The ordinary answer route takes `{ approved }`: true is
"accept" to the server, false "decline", and a turn that moves on cancels it. Any other address
is declined without asking anyone. A form elicitation is declined in v1, and the thread says
once, as an `error` notice `elicitation_unsupported`: "SERVER asked for details Ponzu can't
show yet, so Claude went on without them."

### Credentials

- **Git.** The sandbox has a credential helper that asks the API for a one-hour
  token for the canvas's repository. No GitHub secret is stored in the sandbox.
- **Commits** are authored by the person (their GitHub noreply address) and
  committed by the app.
- **Pull requests** are opened, read and merged by the API: read as the App, opened, merged
  and acted on as a person ("Pull requests" says why): whoever presses Create PR or the action
  button, or, when the agent drives it, the person its turn is for ("The agent's pull
  request"). The agent has no GitHub API token; it hands the API its summary of the change with
  the runner's own tool, `describe_pull_request`, and opens, readies, updates and merges with the
  runner's other pull request tools (beside Ponzu's tools, for a canvas with a repo), which
  post `/v1/runner/pull-request…`. Once a merge has gone through, the API deletes the
  branch as the person, while it is still at the commit that merged.
- **Claude.** The owner's credential (an OAuth token from `claude setup-token`, or
  an API key) is passed in the env of the runner's start command at every start of the
  sandbox. It is never written to disk, never in the sandbox's own env, and never in a
  snapshot. Moving it behind
  an egress proxy is hardening work, tracked below. A canvas runs on its owner's account from
  start to finish (`canvases.claude_account_id`). `/v1/claude` connects one: an API key once
  Anthropic takes it (a free `GET /v1/models`), or a subscription by `claude setup-token`, run
  in a utility sandbox made from the canvas image with no credential at all
  (`pz-<scope>-signin-<id>`, not persistent, a 15-minute session, its session id kept in the
  sign-in's auth state): `POST /v1/claude/sign-ins` writes a driver into the sandbox, starts it
  (it runs `/opt/ponzu/bin/claude setup-token` in tmux) and reads the claude.ai address back from
  the file it writes, and `POST /v1/claude/sign-ins/:id/code` writes the pasted code into the
  sandbox as a file, reads the token back as one, seals it and removes the sandbox. The driver
  writes what it says to 0600 files (`~/.st/start.out`, `~/.st/code.out`), never to its output,
  because Vercel keeps a command's output; the code and the token are never in a command line,
  a command's output, a log or an answer. A sign-in is good for ten minutes and one code (`claude_code_invalid`,
  `claude_sign_in_expired`, `claude_sign_in_used`). Each sign-in is a machine Ponzu pays for, so a
  person has one open at a time (a new one replaces the last, and its sandbox is removed) and
  starts at most five an hour (429 `rate_limited`); reconcile removes the sandbox of one left
  open. Disconnecting destroys the credential, keeps the row (`revoked`), and puts every awake
  sandbox whose runner was started with it to sleep at once ("The sandbox"): the credential
  lived only in that runner's memory, so an asleep sandbox holds nothing of it. A canvas whose
  owner leaves the workspace stops running on their Claude the same way: it does not wake
  (`claude_owner_left`), and the sweep puts an awake one to sleep, until a teammate takes it
  over onto their own Claude ("Deleting an account").
- **Repo secrets** are stored encrypted per repo and passed in the runner's start command
  at every start of the sandbox ("Repo environments").

### Models

What a canvas may run on is what Claude Code offers the person's Claude account, not a list
Ponzu keeps. Each time the runner starts Claude Code it reads the Agent SDK's
`supportedModels()` (`initializationResult()`, which Claude Code answers when the session
starts, so nothing is sent to Claude and no turn waits on it), and posts it to
`POST /v1/runner/models` with the Claude Code version that said it, beside the first turn rather
than ahead of it. It posts only when the answer differs from what the session said the API
holds, came from another Claude Code, or is more than a day old, so a plan that gains or loses a
model shows up within a day. The API keeps it on the account (`claude_accounts.models`, with
`models_reported_at` and `models_claude_code`), only while the sandbox that reported it runs on
the credential the account holds now; connecting another key or subscription clears it.
A runner's first report is kept, and after it at most one in ten minutes: the window is held on
the account (`models_reported_at`), so a report is refused while the account's last was kept in
the past ten minutes and after this runner took its lease. Runners on one account share the
window, which only matters when two images report different answers within ten minutes: the
second is said again at its runner's next start. A refused report is answered 200 with
`kept: false`, never 429, so the runner does not try again, and logged as
`claude_models_reported` with `refused: "too_soon"` (or `"old_credential"`).

`supportedModels()` answers aliases, not model ids. For the development API key on Claude Code
2.1.322 it was `default`, `opus`, `fable`, `sonnet` and `haiku`, each with `resolvedModel` (the
full id it runs as now, `claude-opus-5-5`), a short `displayName` (`Opus`), a `description` that
begins with the version (`Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok`), and
`supportedEffortLevels` (all five, for each). That answer is recorded in
`apps/runner/src/agent/fixtures/supported-models.api-key.json` by
`apps/runner/scripts/supported-models.ts`, which the tests use. What a subscription is answered
has not been observed; the API takes whatever arrives. `apps/api/src/claude/models.ts` turns a
report into the picker's rows:

- each entry runs on its `resolvedModel`, or on its `value` when Claude Code gives none, so a
  saved choice keeps naming one model whatever the alias later points at;
- `default` (whatever Claude Code runs by default) is never a row, and an id already offered is
  not offered twice; a `default` whose model no other entry offers is offered under its id;
- a model the hand-kept list knows takes its name and its place in that list; any other comes
  after, in Claude Code's order, named by the start of its description when that is its
  `displayName` and a version (`Opus 6`), otherwise by its `displayName`, put on one line and
  cut to 40 characters (the apps render it as text, never as markup);
- each row carries the efforts it takes (`supportedEffortLevels`; none when `supportsEffort` is
  false; all five when Claude Code says nothing).

`GET /v1/claude/defaults`, the query the model picker and Settings read, answers those rows. An
account nobody has reported for (just connected, never run) is offered the hand-kept list, so the
picker is never empty. The default is Opus 5.5 on medium when the account offers it; otherwise
the model Claude Code calls its default, otherwise the first offered. `PATCH /v1/claude/defaults`
and `POST /v1/canvases` take only a model the account offers and an effort that model takes (400
`model_not_offered`). For a model that takes no effort the defaults show medium, so an effort
sent with it is let through; it is never run with one. A saved choice the account no longer offers is not an error: the defaults
answer what will run in its place, which the picker shows, and a canvas made on it runs on that
at its next start (the runner session's `model`), logged as `model_unoffered`, so Claude Code is
never handed a model it would refuse once a runner has reported. The canvas's thread says so:
as that runner's session starts, the API (never the runner, which is refused with 400 if it
tries) writes a notice `{ type: "model_changed", from, to, fromName, toName, account }` under
the id `ti_model-` and the first 12 hex digits of the SHA-256 of `from→to`, so each change is
said once however often the canvas starts (a canvas that goes back to its model and then loses
it again to the same one is not told twice). It is written only once a runner has reported what
the account offers: before that (a credential just connected again, or one revoked) the canvas
still runs on the default in its place, but nobody knows its model is gone, so the thread says
nothing and only the log does (`reported: false`). The names are the ones the API knows then (what the
account is offered, else the hand-kept list, else the id), since the model gone is no longer in
what the account offers; `account` is whose Claude it is, the canvas's owner when they hold the
account, else null. The apps say it as "Maya's Claude doesn't offer Fable 5.2 any more, so this
canvas now runs on Opus 5.5." ("Your Claude" to the person whose it is), and it is not an answer
to anyone's message. The apps hear of a new report only when they read the defaults again (the `me`
live query does not carry the report): a create or a defaults change refused with
`model_not_offered` reads them again, as does connecting another credential, so the picker
then shows what the account offers. Before the first report the hand-kept list is offered as
it is, so a model in it that the account does not have is still handed to Claude Code once.

**When Anthropic ships a model, or Claude Code updates.** The list comes from the Claude Code in
the sandbox image, and the runner bundle's Agent SDK must match it (`bundle-fits`). So a new
model appears once a Claude Code that knows it is pinned (`apps/runner/image/pins.json` and the
runner's `@anthropic-ai/claude-agent-sdk`), the image is rebuilt (`image.yml`) and the API that
carries the matching runner is deployed. No Mac or iPhone release is needed and no list in Ponzu
is edited: the first runner on the new image reports it, and every app's picker offers it under
Claude Code's own name. A model Anthropic retires goes the same way: once Claude Code stops
offering it, it is not offered, and canvases made on it run on the default. The pin bump itself
is the other track's scheduled job, not part of this; until it lands, a bump is a pull request
by hand. Not proven: whether Claude Code ever learns of a model without a new binary (for
example from its own server for a subscription); if it does, that model is offered as soon as a
runner reports it.

### Claude plan limits

A Claude subscription's plan has limits (a five-hour session, the week, and on some plans a
week on Opus or on Sonnet), and a canvas runs on its owner's plan alone, so a plan at its limit
waits for everyone, not only its owner, until it resets.

- **What Claude Code says.** On a subscription Claude Code emits the Agent SDK's
  `rate_limit_event` whenever a window's status, reset or rounded share moves: `status`
  (`allowed`, `allowed_warning` or `rejected`), `rateLimitType` (the window), `resetsAt`
  (seconds since the epoch) and `utilization` (a fraction, which can run a little past 1). The
  runner passes each on with its state as `claudeLimit` ("State"), once each, the latest for
  each window; on an API key it passes on nothing (`planLimits` in the runner's options, set
  from `CLAUDE_CODE_OAUTH_TOKEN`). A `rejected` window that the plan's extra usage still
  carries (`overageStatus` allowed or allowed_warning) is passed on as `allowed_warning`, since
  requests still go through. A turn that fails at the limit still says so in the thread
  (`claude_limit`, with Claude Code's own words). Not observed live: the fields come from the
  SDK's types and its binary's own description of them, and a test feeds a scripted event.
- **What the API keeps.** `claude_accounts.limits` holds each window as last reported (`window`
  in the SDK's name, `utilization`, `resetsAt`, `at`), and `limited_until` is set to the reset
  of a `rejected` window and cleared by any other status, which says requests go through. Both
  are written only when the reporting sandbox runs on the account's current credential (the
  rule models follow) and only for a subscription; connecting again clears them. A reset more
  than eight days off (`MAX_RESET_AHEAD_MS`) is taken as no reset, so a mistaken or forged
  report cannot hold the account's canvases for longer than any window lasts. A report that
  requests go through again lifts `claude_limited` from the canvases on the account at once
  (`resumeBlocked`), rather than leaving them to the reset they were told.
- **The wake gate** (`claudeLimit`). A canvas whose account has `limited_until` in the future
  does not wake: its head says `claude_limited` until `limited_until` plus 30 seconds
  (`LIMIT_GRACE_MS`), and the same wake job is tried again then. A turn already running is never
  cut. A runner still awake on such a canvas is handed only a stop, a person's edit and a push
  (`claimableKinds`), none of which begins a turn; a message, answer, comment, check or review
  waits in the feed and goes in at the reset.
- **The apps.** Every viewer of the canvas reads the head's `claude_limited` and
  `agent_blocked_until` alike: "Maya's plan is at its limit until 4:00 PM. This canvas waits."
  ("Your plan …" to the owner), and under it "Your message goes in when it resets." The composer
  still sends. Before a wake has put it on the head, the owner also learns of their own plan's
  limit from `limitedUntil` on their account. `GET /v1/claude` (and `me`) carries `limits`,
  `[{ window, utilization, resetsAt }]`, empty before any canvas has run and null for an API
  key; Settings › Agents shows the windows it knows ("Current session", "This week", "This
  week, Opus", "This week, Sonnet"), in that order, and hides any other.

## The runner protocol

What the runner and the API say to each other. The runner's whole view of the API is
`RunnerApi` (`apps/runner/src/api/api.ts`); every body below is a type in
`apps/runner/src/api/protocol.ts`, which the apps import for the thread's items
(`@ponzu/runner/protocol`). `apps/runner/src/api/fake-http.ts` serves the in-memory fake
behind these routes, and is the reference for what each answers.

### Rules for every call

- **Who.** The bearer is the runner token (`pzr_…`), declared with `access.runner`. A runner
  route acts on `actor.canvasId` and takes no canvas id; a document route's `:id` that is not
  the token's canvas answers 404 `not_found`. A token that is unknown, expired or revoked
  answers 401 `token_invalid` everywhere. The API revokes a canvas's runner tokens when the
  canvas is deleted or settled, so that is also how a runner hears its canvas is gone. The
  runner names itself: `X-Ponzu-Client: runner/<version>+<bundle>`, the first 12 hex of the
  bundle's SHA-256 it was started with as semver build metadata (`runner/0.1.0+2de5aff8d903`), or
  `runner/<version>` outside a sandbox.
- **One runner at a time: the lease.** `POST /v1/runner/session` mints a runner id (`rnr_…`)
  and records it as the canvas's runner, replacing any before it. Every other call, the
  document routes and git's credential helper included, carries it as `X-Ponzu-Runner`, and
  the API answers 409 `superseded` to a call without the current one. Two processes for one
  canvas (a botched restart, a second sandbox) would otherwise resume the same Claude session
  and act on the same events twice; with the lease the older one is refused at its next call.
- **Stopping for good.** On 401 `token_invalid` or 409 `superseded`, from any call, the
  runner interrupts the turn, writes nothing more, closes Claude Code and exits 78, which its
  supervisor does not restart. Only a new `ponzu-start`, with a new environment, brings a runner
  back: the next wake runs one, and the sweep's `restart` step wakes a sandbox whose runner went
  quiet for 90 seconds.
- **Batch, never chat.** The sandbox and the API are both in `iad1`, but a call is still a
  round trip through Vercel's edge, so each route takes many things at once and the runner sends
  what piled up: thread
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
  alphabet (`packages/db/src/ids.ts`), and the API keys them by canvas: a thread item or a
  question is found by `(canvas_id, id)`, so the same id in another canvas is another row,
  and nothing a runner sends can reach or reveal another canvas's.
- JSON is camelCase; times are ISO 8601.

### Routes

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/v1/runner/session` | `{}` | `RunnerSession`, with the lease `runnerId` |
| POST | `/v1/runner/events/claim` | `{ claimId, limit?: number }` | `{ events: RunnerEvent[], seq, pullRequest }` |
| POST | `/v1/runner/events/ack` | `{ ids: string[], claudeSessionId: string \| null }` | `{ acked: number }` |
| POST | `/v1/runner/thread` | `{ items: ThreadWrite[] }` | `{ items: [{ id, seq, streaming }] }` |
| PUT | `/v1/runner/state` | `{ state, status, artboards, claudeSessionId, branch? }` | `{ seq }` |
| POST | `/v1/runner/questions` | `{ id, kind, payload }` | `{ id, status }` |
| POST | `/v1/runner/questions/withdraw` | `{ ids: string[] }` | `{ withdrawn: number }` |
| POST | `/v1/runner/uploads` | `{ files: [{ purpose, name, contentType, size, sha256 }] }` | `{ files: [{ id, put: { url, headers }, expiresAt }] }` |
| PUT | `put.url` from the above | the bytes, with `put.headers` and no bearer | 200 |
| POST | `/v1/runner/uploads/complete` | `{ ids: string[], seq?: number }` | `{ files: [{ id, ref, url }] }` |
| POST | `/v1/runner/git-credential` | `{ protocol, host, path }` | `{ username, password, expiresAt }` |
| POST | `/v1/runner/git-credential/erase` | `{ protocol, host, path, reason? }` | 204 |
| POST | `/v1/runner/git-report` | `{ name, fields }` | 204 |
| POST | `/v1/runner/usage` | `{ turns: TurnUsage[] }` | `{ recorded: number }` |
| POST | `/v1/runner/models` | `{ claudeCode, models: ReportedModel[] }` ("Models") | `{ kept: boolean }`; at most one kept in ten minutes after a runner's first, never 429 |
| POST | `/v1/runner/pull-request-summary` | `{ summary }` | `{ pullRequest: number \| null, open, kept }` |
| GET | `/v1/runner/pull-request?turn=` | none | `PullRequestStanding` ("The agent's pull request") |
| POST | `/v1/runner/pull-request/open`, `/ready`, `/auto-merge` | `{ turn }` | `AgentPullRequestAnswer` |
| POST | `/v1/runner/pull-request/update-branch`, `/merge` | `{ turn, headSha }` | `AgentPullRequestAnswer` |
| POST | `/v1/runner/checkpoint` | `{ turn, claudeSessionId, wipCommit, session, workspace }` | `{ saved: SavedPoint }` |
| POST | `/v1/runner/restore` | `{}` | `{ saved, session, workspace }`, each archive `{ url, size, sha256 }` or null |
| POST | `/v1/runner/restored` | `RestoredReport` | 204 |
| GET | `/v1/runner/bundle` | none | the runner bundle's tgz, `x-ponzu-bundle-sha256` |
| POST | `/v1/canvases/:id/ops` | `{ ops: [{ id, op }] }` | `{ committed, rejected, seq }` (Committing) |
| GET | `/v1/canvases/:id/ops?after=N` | none | `{ ops, seq }`, 410 when N is too old (Reading) |
| GET | `/v1/canvases/:id/doc` | none | `{ doc, seq }` (Reading) |
| POST | runner `/poke` | none | 204 |
| GET | runner `/health` | none | `{ started, state }` |

Every route but the session's, the bundle, the upload `PUT` and the runner's own two answers 409
`superseded` without the current `X-Ponzu-Runner`.

### Session

`POST /v1/runner/session` is the runner's first call: everything it needs to start, and the
lease.

```
RunnerSession = {
  runnerId,                                      // rnr_…, this process's lease: X-Ponzu-Runner
  canvas: { id, name },
  repo: { owner, name, defaultBranch } | null,   // null for Scratch
  branch: string | null,                         // pz/<topic>, null for Scratch
  claudeSessionId: string | null,                // the last one an ack or a state report named
  model: string | null, effort: "low" | "medium" | "high" | "xhigh" | "max" | null,
  author: { name, email },                       // the person: <id>+<login>@users.noreply.github.com
  committer: { name, email },                    // the App's bot
  assetBase,                                     // https://assets.ponzu.cloud/<asset key>
  link,                                          // opens the canvas in Ponzu
  theme: "light" | "dark" | null,                // the owner's canvas, once known
  openQuestions: string[],                       // still open from an earlier run
  seq,                                           // the canvas's head
  saved: SavedPoint | null,                      // the last checkpoint ("Checkpoints")
  workspaceId,                                   // the canvas's workspace
  analytics: { key, host, content } | null,      // where turns are traced (docs/analytics.md)
  models: { claudeCode, at, models: ReportedModel[] } | null  // what the API holds ("Models")
}

ReportedModel = { value, resolvedModel: string | null, displayName, description,
                  efforts: ("low" | "medium" | "high" | "xhigh" | "max")[] | null }
```

`model` and `effort` are what the canvas was made with while its account offers them, or what
runs in their place ("Models"); null is Claude Code's own default.

Each call mints a new `runnerId` and makes it the canvas's; the runner keeps the last one it
was answered with, so a retry after a lost answer is safe. `openQuestions` stay open: their
answers come in as messages (Questions).

### Events

```
RunnerEvent = { id, seq, at, priority: "now" | "next" | "later", from: Person | null,
                posthogSessionId: string | null, trace: boolean, kind, payload }
Person      = { id, name, login }
```

`posthogSessionId` is the PostHog session of the app that sent it, when it said: the turn the
event begins is traced under it (docs/analytics.md). `trace` is false when the person behind it
has turned Share usage data off, as their row says at the claim: the runner sends no `$ai_*` for
a turn whose first event says false. An older API leaves it out, which counts as true.

| Kind | Priority | Payload | Into the run |
|---|---|---|---|
| `message` | now | `{ text }` | a user message, priority `now`, as from a person |
| `answer` | now | `{ questionId, question: { kind, payload }, answers?: { [question]: answer }, approved?, note? }` | to the question waiting for it; when none is (its run ended, the sandbox slept), a message that says again what was asked, from `question` |
| `comment` | now on a board in `agent_artboards`, else next | `{ threadId, messageId, text, reply, artboardId, artboardName, nodeId }` | a user message, priority `now` or `next` |
| `edit` | later | `{ summary, artboards: [{ id, name }] }` | never starts a turn. During a turn, held until the agent next calls a canvas tool (then priority `next`, read right after that call) or the turn ends; otherwise into the transcript at once without a turn (`shouldQuery: false`), to be read with whatever starts the next one |
| `check` | next | `{ name, conclusion, url, summary }` | a user message, priority `next` |
| `review` | next | `{ state, reviewer: { login }, body, url, comments: [{ path, line, body }] }` | a user message, priority `next` |
| `stop` | now | `{}` | interrupts the running turn and what was put in behind it; nothing goes in |
| `push` | now | `{}` | nothing goes in: the runner pushes the canvas's branch now, without the agent (Create PR with commits only the sandbox holds, "Pull requests") |

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

**Claim.** `POST /v1/runner/events/claim` hands the calling runner the canvas's events that
are not acknowledged and that it has not been handed before, oldest first, at most `limit`
(100, the most there is), and records them as claimed by it. An event is handed to a runner
once: one claimed by an earlier runner, which is gone, is the next one's, and nothing a live
runner holds is handed out again, so an old event never stands in front of a new one. A page
that comes back full is followed at once by another claim. The answer carries the canvas's
head `seq`, read in the same statement, which the runner gives its replica. Each claim carries
a `claimId` the runner chooses, new for each claim and kept until one is answered: a claim
sent again with the same id, because its answer was lost, hands out again what that claim
handed out and has not been acknowledged, and nothing new. Safe to repeat.

**Ack.** `POST /v1/runner/events/ack` marks events delivered, by id; those already marked,
another canvas's, or never handed to this runner are left alone, and `acked` counts what
changed. It also stores `claudeSessionId`, when it is not null, as the canvas's Claude
session, in the same transaction: the session an event went into is the one the next runner
resumes, even when no state report got through. The statement holds to the lease itself, so
an ack from a runner superseded while its call was let in changes nothing. Safe to repeat.

The runner acknowledges an event only once **the Claude session holds it**: Claude Code has
taken its message into the session's transcript (the message's lifecycle reached `started`,
or its uuid came back on a reply), or, for an answer, the question's tool result is in it.
Until Claude Code has said which session that is, those acks wait. Each event's message goes
in under a uuid derived from the event's id, so the transcript says which events it holds: a
runner that starts again reads it before it delivers anything, and acknowledges, without
delivering again, whatever was taken before the last one died; a turn that died with it is picked
up ("A turn that never came"). A copy the API sent again (`payload.retryOf`, any kind) is always
put in, whatever the session holds of what it repeats, with a first line saying it was sent
before; a runner already picking up the turn it repeats acknowledges it without putting it in. Some are acknowledged without
going in, with `claudeSessionId` null when nothing else in the batch went in: a stop once its
interrupt is sent; what a stop cancelled; a kind this runner does not know; and a message
Claude Code turned away (a repo's `UserPromptSubmit` hook), which would only be turned away
again and is said in the thread instead (`message_refused`).

### The thread

```
ThreadItem  = { id, seq, at, streaming, kind, payload }
kind        payload                                                       written by
message     { text, from: Person }                                        the API, with the event
comment     { threadId, messageId, text, artboardId, artboardName, pageId,    the API, with the event
              pageName, at, from, picture? }
assistant   { text }                    markdown, streams                 the runner
tool        { label, steps, artboards, turn? }  one turn's work (below)   the runner
notice      { type: "waking" | "resumed" | "started" }                    the runner
            { type: "question", questionId, header, text }                the runner
            { type: "error", code, message }                              the runner, and the
                                                                          API for a turn that
                                                                          never came
            { type: "stopped", by: Person | null }                        the API, from the runner's
                                                                          { type: "stopped", eventId }
            { type: "pull_request", number, url, title, state }           the API
            { type: "pull_request_agent", action, number, url, title,     the API
              as: Person, at }
```

A `comment` item also says where it was left (`pageId`, `pageName`, and `at`, the pin's place on
the page in page px) and, once its author's app has attached one, `picture`: the area round the
pin as it was when the comment was made, the pin drawn in with its number, as `{ light, dark,
width, height }` (`COMMENT_PICTURE`, 240 × 160 shown, at twice that: WebP from the Mac, PNG from
the iPhone, whose WebKit can't write WebP; a reader takes either). The app that sent the comment
draws it from the document as it stood then (the Mac in its window, the iPhone in its canvas
page, both with packages/canvas's `comment-picture.tsx`), uploads it with `POST
/v1/canvases/:id/comments/:messageId/picture` (two files of one format, `light.webp` and
`dark.webp` or `light.png` and `dark.png`, at most 2 MB each, staged and copied under
`comments/` when attached) and attaches it with `…/picture/complete` once the comment's op is committed
(404 before that); the first picture attached is the one it keeps. Sending a comment never waits
on it. A comment with no picture (from before pictures, or one that couldn't be drawn or kept)
says where it was left instead. Older comment items may carry `board`, a copy of the board an
earlier thumbnail drew; nothing reads it.

A client renders the thread from these alone, and never shows a tool's input or output.

**A turn's work** is one `tool` item, which the runner opens the first time the turn shows
anything (before its first message, so everything the runner writes until the next such item
belongs to that turn) and finishes when the turn ends. While it streams, `label` is the working
state; once finished, a few words for what the turn did ("Worked on 3 boards and 1 file").
`artboards` are the boards it was on. `turn` is the turn's record:

```
turn = { ended: "done" | "stopped" | "failed" | null,   // null while it runs; a question ends "done"
         ms,                                             // how long it ran, so far
         final: ti_… | null,     // its answer: the last assistant item, unless it worked on after it
         boards, files,          // boards it made or changed, files it changed, each counted once
         log: [{ after: ti_… | null, text: string | null, count }] }
```

`log` is the turn's steps in order, each said in the past tense from the same phrases as the
working state (`Drew "Hero"`, "Edited src/app/page.tsx", "Ran tests"), grouped after the
assistant item they followed (null before the first), a repeat after the same message counted
rather than listed. At most 120 groups carry text (120 characters each); later steps are counted
in a group with `text: null` after their message, and once the log holds 240 groups, in its last
`text: null` group, so a turn of hundreds of tool calls, or one that talks for hours, is a few
kilobytes. The API refuses a record past those bounds; a runner whose write is refused sends the
write's other items again on their own, so one item never takes the agent's text down with it.

The thread shows people's messages, the agent's messages and, while a turn runs, one working
line; nothing of a turn's work, ever. While it runs, each message the agent has gone on working
after (a later message, or a `log` group `after` it) is an aside, set quieter and in italics;
its newest words read plain until it carries on. Once it has ended only its answer stays:
`final`; with no `final`, its last message if it ended `done` (or its record isn't closed yet),
and none if it was stopped or failed, when how it ended (the stop, the error) is its last line.
A question answered on the way, a pull request and a person's message mid-turn stay where they
are. The asides and the working line leave together, closing their room and fading at the pane's
pace (at once with reduced motion), so the answer settles into place; a thread opened later is
drawn already settled.

So clients read `final`, `ended`, and `log[].after`, and nothing else of the record: `ms`,
`boards`, `files`, `log[].text` and `log[].count`, and the item's `label`, `steps` and
`artboards`, were the fold's ("Worked for 4 min · 7 boards · 1 file", opening on each message's
steps), which is gone. The runner still writes them; the protocol is unchanged.

A runner from before the record (whose items are in canvases already) wrote one `tool` item per
stretch of tool calls between two things the agent said, with no `turn`. Clients read those
turns by position: a turn starts at the agent's first item after a person's, runs while the
agent works, and a message with a stretch after it is an aside; once it has ended, its answer is
its last message, unless the turn was stopped or failed after it. The stretches themselves
never show, nor their labels (often whatever the agent last set with set_status).

An `assistant` item cut off by an interrupt is finished with the text it had. `error` codes:
`clone_failed`, `claude_auth`, `claude_limit`, `model_unavailable`, `max_turns`, `turn_failed`,
`agent_exited`, `message_refused`, `question_failed`, `push_failed` (the runner gave up pushing
the branch; its message says why and what to do, in Ponzu's words, once for a commit and a
reason). The API writes `turn_failed` itself, under `ti_lapsed-<event>` or `ti_stalled-<runner>`,
for a turn that never came. The `waking` notice becomes `resumed` or
`started` once Claude Code is up. A `pull_request` notice is written once for each pull request
opening, merging and closing, under an id of its own (`ti_pr-<number>-opened`, `-merged`,
`-closed`) that no runner can write, whichever of a route and a webhook sees it first. A
`pull_request_agent` notice is the agent's own line for each thing it did to its pull request
(`action`: `opened`, `ready`, `updated_branch`, `auto_merge`, `merged`), naming the person it
acted as, under `ti_pra-<random>`, which no runner can write either ("The agent's pull request").
The thread draws it as "Claude merged #12 as Maya", and an opening or merging the agent did is
said by its line alone, not again by the `pull_request` notice for the same moment.

`POST /v1/runner/thread` writes items by the id the runner chose (`ti_…`): an id the thread
does not have is appended, an item still streaming has its payload replaced, and a finished
one is left as it is (the answer says `streaming: false`, and the runner sends nothing more
for it). A runner writes only `assistant`, `tool` and the notices it owns (`ThreadWrite`):
`waking`, `resumed`, `started`, `question`, `error`, and `stopped` as `{ type: "stopped",
eventId }` naming one of the canvas's `stop` events, which the API stores as `{ type:
"stopped", by }` with the person from that event. Any other notice type, or a `stopped` that
names no stop of the canvas, is 400 `invalid_request` and the whole write is refused: what only
the API knows (a pull request, who stopped the run) is never taken from a sandbox, where the
agent can run anything. At most 32 items a call; agent text is clipped to 32,000 characters,
so a payload stays far under the table's 256 KB. Safe to repeat.

### State

`PUT /v1/runner/state` says what the agent is doing, as the canvas's row shows it:

```
{ state: "working" | "needs_you" | "idle",
  status: string | null,       // the working state; while not working, what is wrong, if anything
  artboards: string[],         // what the agent is on, from the canvas tools
  claudeSessionId: string | null,
  branch?: { unpushed: number,   // commits on the canvas's branch that GitHub lacks
             error: string | null } | null,  // why the last push of them failed, for a person
  claudeLimit?: { status: "allowed" | "allowed_warning" | "rejected",
                  window: string | null,      // the SDK's rateLimitType, five_hour, seven_day, …
                  resetsAt: string | null,    // ISO 8601
                  utilization: number | null } | null }  // what Claude Code said of the plan
```

`claudeLimit` is news, like `branch`: sent once for each `rate_limit_event` that changes a
window, one window per report, and absent on heartbeats and from a runner on an API key. The
API keeps it on the Claude account ("Claude plan limits"); an older API ignores it.

**The working state** (`status` while `working`) is said from the tool call running now, never
from a status the agent set long before: most specific first,

1. a tool call running: its phrase, for as long as it runs (`Drawing "4 · About you"`, "Reading
   src/app/page.tsx", "Running the dev server", "Searching the repo for "Button"",
   "Committing "Add pricing card"", "Looking up the Tailwind docs"); the newest when several
   run at once; the plain one ("Drawing on the canvas") from the moment the model starts
   writing the call, the specific one as soon as the input's naming keys are written (the
   runner reads the input as it streams, so a board's name or a file's path shows while its
   HTML or contents are still being written);
2. else what the agent said it is about: set_status fills the gap after it was set and ends
   when the agent's next call begins; its todo list's step in progress lasts until it next says
   something;
3. else "Thinking": between calls, while text streams and right after it.

Before Claude Code is up it is "Waking up". Boards are named by their names, files by a short
path (cut from the left at whole folders, never the file's name); shell commands are recognised
by shape (git, package managers, tests, dev servers, builds, linters) and are otherwise
"Running a command": never a command line, an argument, an address's path or query, a file's
contents, or text that looks like a secret, and never one of the sandbox's own secret values
(the repo's secrets, the Claude credential, the runner token). Clients show it at the thread's
foot with the turning slice from the moment a person sends until the turn's item finishes, and
take it away in the frame the turn's asides go, whichever of the item and the idle report comes
first.

`branch` is sent once for each push the runner made or tried (at its start, at the end of each
turn, before a sleep, and on a `push` event), with the report that follows it, and not with the
heartbeats after; absent, the API keeps what it had. Said again with every heartbeat, an old
failure would undo Create PR's clearing of it before the push Create PR asked for had run. The API keeps it on `canvas_runners` (`unpushed`, `push_error`), where the pull request
tab reads it ("Pull requests").

`needs_you` while the agent waits on a person, and while a question it asked stays open
after its run (Questions); `status` while not working is a clone that failed or a turn that
failed on Claude's credential or limit, until a turn works. The runner sends it when it
changes, at most twice a second, and every 30 seconds whatever happens: the **heartbeat**.
The API stores the session id, when not null, for the next resume, keeps a sandbox awake while
its runner reports `working`, and takes one it has not heard from in 90 seconds as dead. The
answer is the canvas's head `seq`. A sleep does not go through the state: the API runs
`ponzu-stop`, and the runner's SIGTERM shutdown reports its final state on the way out. Safe to
repeat: the last one wins.

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
and `dark.png`, of the first page laid out as the boards view shows it, with `seq` the canvas's
seq they show (`canvases.preview_seq`); the runner draws them a few seconds after the canvas
stops changing and its edits reach the API. Completing an id again is safe; 404 `not_found`
for an id whose bytes never arrived. The purposes `session` and `workspace` are a checkpoint's
archives (`session.tar.gz`, `workspace.tar.gz`, `application/gzip`, 64 MB each), stored apart
from every canvas's files ("Saving the sandbox") and recorded by the checkpoint, never completed
(400).

### Checkpoints

`POST /v1/runner/checkpoint` records a checkpoint whose archives were just uploaded:

```
SavedPoint = { turn, at, claudeSessionId, wipCommit, session: boolean, workspace: boolean }
```

`turn` must be above the canvas's last for anything to change, and the answer is the
checkpoint the canvas has now, this one or a newer one; the archives it replaced, or that were
not recorded, are deleted. An archive id must be this runner's upload of that purpose, in storage
as declared (404 `not_found`). `wipCommit` is the work in progress's commit, for a repo canvas,
which the `workspace` archive carries as a bundle. `keep: { session?, workspace? }` keeps the
last checkpoint's transcript (with its session id) or work (with its commit) in place of one this
checkpoint does not carry. Holds to the lease (409 `superseded`). Safe to repeat.

`POST /v1/runner/restore` answers the last checkpoint with an address per archive that reads it
for ten minutes, and its size and SHA-256, which the runner checks. `POST /v1/runner/restored`
says the runner found its disk behind the checkpoint and restored from it: `kind` (`rollback` when
the disk had an older marker, `rebuilt` when it had none), the disk's marker and the boot that
wrote it, the checkpoint's, this boot's id and start, and what was restored. The API logs it
(`sandbox_rollback` as a warning, `sandbox_rebuilt`) with the sandbox's session and image, and
captures `sandbox restored`. Safe to repeat.

### Git

The checkout's git asks for credentials through a helper, `bun git-credential.js <socket>`
(`credential.https://github.com.helper`, with `credential.https://github.com.useHttpPath
true`, and an empty helper before it so no other is asked). It asks the runner over a local
socket (`/run/ponzu/git.sock` in the image, open to the runner and the agent's user only) and
writes nothing down; the runner calls `POST /v1/runner/git-credential` with its own token and
lease (`X-Ponzu-Runner`), so the git of a superseded runner gets nothing and the agent's side
never holds the runner token. The request is what git asked: `{ protocol: "https", host:
"github.com", path: "<owner>/<name>.git" }`. The API mints a one-hour installation token for that one
repository (`contents: write`, `metadata: read`), or reuses one with ten minutes or more
left. 403 `forbidden` for any other host or repository, 404 `not_found` for Scratch, 502
`upstream_unavailable` when GitHub fails. When GitHub refuses a token, git calls `erase`, and
the API drops the token it was reusing. Both are safe to repeat. A token is kept for reuse only
in the memory of the function instance that minted it, never in a row, so an `erase` that lands
on another instance leaves the first one's in use until it has ten minutes left.

GitHub can refuse a token it has just minted. On 2026-11-11 a push with a token minted that
instant, and again three seconds later, got `remote: Repository not found.`: what git prints
when GitHub knows the token but does not let it see the repository's contents. A token minted
seven minutes earlier pushed. git calls `erase` only after a 401, never after that 404, so
nothing heard of it, and the agent's commit stayed in the sandbox. So:

- **The API checks what GitHub granted.** GitHub's answer to the mint lists the token's
  permissions and repositories; one without `contents: write` on the canvas's repository is
  minted again once, and then refused (502). Every token handed to git is logged
  (`git_credential`: minted or reused, a fingerprint, which is the first 12 hex characters of
  its SHA-256, its expiry, and the permissions and repository ids GitHub granted), and so is
  every erase (`git_credential_erased`, with the fingerprint it dropped and the runner's
  `reason`). Never the token itself.
- **The runner hands git only a token GitHub honours.** Before it answers the helper it asks
  GitHub's git endpoint for the repository's refs as a push would (`GET
  /<owner>/<name>.git/info/refs?service=git-receive-pack`, from the sandbox, with the token):
  200 means the token may push, 404 means GitHub does not (yet) let it see the contents, 403
  that it may only read. While GitHub refuses, it waits (half a second, growing, about 15
  seconds in all, inside the helper's 30); after four refusals of one token it gives that token
  back (`erase`, with why) and checks the next. One that passed is not checked again. When GitHub
  cannot be asked, or keeps refusing past the budget, git gets the token anyway and fails as it
  would have. The runner logs each check (`git_credential_ready`, `_refused`, `_unchecked`,
  `_unready`) by fingerprint (`apps/runner/src/git-token.ts`), and sends the same lines, and
  each try of its own pushes (`git_push`: attempt, ok, kind, git's last words, ms), to the
  API's log (`POST /v1/runner/git-report`, best-effort), so whether GitHub ever made a new token
  wait can be read from the API's logs after the sandbox is gone.
- **The runner pushes what the agent did not** (`apps/runner/src/push.ts`). At the end of every
  turn (after the turn's checkpoint, which already holds the commits), before the sandbox sleeps
  (after the checkpoint, within what the stop's wait leaves), when it starts (a restore may have
  brought commits back) and on a `push` event, it pushes the canvas's branch (`git push
  --porcelain -u origin refs/heads/<branch>`, as the agent, through the same helper) when it has
  commits GitHub lacks: commits the default branch lacks, and a head other than the one
  `origin/<branch>` last showed. A branch that was on GitHub and is gone (it has an upstream but
  no `origin/<branch>`, or the canvas's pull request was merged) is left gone: Ponzu's Merge and
  GitHub's setting delete a merged branch, and the runner does not put it back; new commits on
  it are pushed, as the agent's own push would. A `push` event during a turn waits for the
  turn's end, so the runner never pushes under the agent's own rebase or push. It never forces:
  a branch that moved on GitHub, a protected branch or a rule that refuses it is reported, not
  retried. Anything else (a ref GitHub had locked for another push too) is tried again after 2,
  5, 10 and 15 seconds, giving the token back before each try. While it pushes commits GitHub lacks, the canvas's state says "Pushing to
  GitHub". It reports the outcome with its state (`branch`), and when it gives up it says so in
  the thread (`push_failed`), once for a commit and a reason. The commits are safe either way:
  the checkpoint's bundle carries every commit GitHub lacks.

At start the runner sets `author.*` to the person and `committer.*` to the App's bot in the
agent's global git config, clones the repository into `~/work/<name>` of the agent's user
(`/home/agent/work` in the image), as that user (or fetches, when the disk kept
it), and checks out the canvas's branch: the local one, else the one on GitHub, else a new one
from `origin/<default branch>`. Work on disk is never reset. A clone that fails is a
`clone_failed` notice and the canvas's status, and the run goes on in an empty folder, so the
canvas still works; the agent is told the repository could not be checked out, and the next
start of the sandbox tries again.

### Usage

`POST /v1/runner/usage` records what each turn used, by model, under the turn's result id, so
recording it again changes nothing:

```
TurnUsage = { id, claudeSessionId, at,
              models: [{ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }],
              turn?: { startedAt, outcome: "completed" | "failed" | "stopped", errorCode,
                       durationMs, toolCalls, eventId } }
```

Claude Code reports a session's running totals; the runner sends the difference from the
totals the last turn reported, which it keeps on disk across restarts. After a crash Claude
Code restores the totals it saved at its last clean exit, and a turn that would come out
below zero counts as zero.

`turn` is how the turn went, sent for every turn the runner sees end, used or not: the API
captures it as "turn started" and "turn finished" (docs/analytics.md), about the person whose
event (`eventId`) began it, as that event's row says.

### People's side

A person steers the run through the canvas's routes, each `requireCanvas` with write access
but the thread's history, which takes read:

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/v1/canvases/:id/messages` | `{ text, attachments?: string[] }` | 201, the `message` `ThreadItem` |
| POST | `/v1/canvases/:id/questions/:questionId/answer` | `{ answers? }` or `{ approved, note? }` | `{ id, status }` |
| POST | `/v1/canvases/:id/stop` | none | 204 |
| POST | `/v1/canvases/:id/take-over` | none | the canvas, now the caller's; 409 `not_ownerless` or `claude_not_connected` ("Deleting an account") |
| GET | `/v1/canvases/:id/thread?before=&limit=` | none | `{ items: ThreadItem[] }`, oldest first, at most 50 |
| POST | `/v1/canvases/:id/uploads` | `{ files: [{ name, contentType, size, sha256 }] }` | as `/v1/runner/uploads` |
| POST | `/v1/canvases/:id/uploads/complete` | `{ ids }` | as `/v1/runner/uploads/complete` |

A message writes its thread item and its `now` event in one statement. Its `attachments` are
files of the canvas by reference (`assets/<name>`), uploaded first; the item's payload and the
event's carry them as `[{ ref, contentType }]`. A person uploads images only, and each is kept
under its own name with six random characters added (`paste-k3v9qz.png`), so it never replaces
one of the canvas's files. An answer is checked against what was asked (every one of a
`question`'s questions by its text and no other, or `approved` for a `plan` or `permission`),
since it closes the question for good; the first wins, and an answer to a question that is
not open is 409 `question_closed`. It writes the `answer` event in
the statement that closes the question, carrying the question as it was raised. A comment a
person posts on the canvas reaches the thread the same way: the commit statement writes the
`comment` item beside its event.

Each of these, and every op a person commits (undo and redo included), then calls
`requestWake` (`apps/api/src/sandboxes/wake.ts`): a message, an answer or a comment records a
wake for the canvas, one at a time, and every reason pokes the runner when the canvas's
sandbox is awake. A stop and an edit record none: a sleeping sandbox is running nothing to stop,
and an edit is `later`. `requestWake` never fails the request that called it: what that wrote
is written, and a wake it could not record is logged (`wake_failed`). A failed check or a review
comes in a webhook's job, which records a wake for the cron to run (`queueWake`) rather than
waiting on a sandbox to start.

### The other way: poke and health

The runner listens on one port (4600), which Vercel serves at the sandbox's public
`https://<sub>.vercel.run` address. Anyone with the address can reach it, so every request must
carry `authorization: Bearer <PONZU_PORT_TOKEN>`, compared in constant time; without it every
route, an unknown one included, answers 401. The bearer is new at every start, only the runner's
process holds it (the agent's environment never does), and the API keeps it sealed on the row.
`POST /poke` (204) carries nothing, and the runner trusts nothing about it: it only claims, from
the API, with its own token. The API pokes when it adds an event to an awake canvas's feed and
when a person's op moves an awake canvas's head, tries a 502 or 503 again for up to a second
(the port can answer those for a moment just after a start), and does not retry a poke that
fails otherwise: the runner also claims once a minute, and each claim and state answer carries
the head. A wake does not poke: its runner claims by itself once it is up. `GET /health` answers
`{ started, state }`, `started` once the canvas is open, Claude Code is up and the claims run;
the image's checks read it, and the API does not need to.

### Environment

`ponzu-start` hands the supervisor its own environment, and the supervisor gives it to the
runner with `runner.json`'s variables (where the image keeps things) over it: `PONZU_API_URL`,
`PONZU_CANVAS_ID`, `PONZU_RUNNER_TOKEN`, `PONZU_PORT_TOKEN`, `PONZU_RUNNER_BUNDLE` and exactly one
of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. With both it refuses to start: Claude Code
would use the key without a word and bill its account. The repo's secrets come packed in one
more variable, `PONZU_REPO_SECRETS`, which the runner unpacks only into the environment of what
it starts, never its own ("Repo environments"). The rest is optional and in
`apps/runner/README.md`. On SIGTERM it stops the turn and says so in the thread, waits a few
seconds for the agent's edits to reach the API, reports its final state (`needs_you` when a
question stays open), saves a checkpoint, closes Claude Code, pushes what GitHub lacks if it can
in time, and exits.

### Pull request summary

`POST /v1/runner/pull-request-summary` takes the agent's words on what its branch changes
(markdown, clipped to 8,000 characters). The API keeps them on the canvas and, when its pull
request is open, writes them into the description on GitHub in place of what it said before.
The answer says what happened: `pullRequest`, the number it was written into, or null; `open`,
the canvas's pull request as the app shows it (`{ number, state }` or null); and `kept`, why the
words were only kept: `none_open` (they become the description of the pull request the person
opens), `rewritten` (one is open but someone rewrote its description without Ponzu's part) or
`unreadable` (GitHub could not be read). Safe to repeat: the last one wins.

The agent says them through a tool the runner hosts beside the canvas tools,
`describe_pull_request({ summary })`, on a repo canvas whose repository is checked out; the
thread calls the step "Writing the pull request description". The tool's answer says what it
did in words the agent can repeat: "Updated the description of pull request #N on GitHub", or
"Saved as the description the pull request will open with. No pull request is open yet: open it
with open_pull_request when the work is ready for a reviewer" (and that commits are still to be
pushed, when they are), or that #N is open and why its description was left alone. A pull
request the person opens with Create PR opens with the same words.

**What the agent knows.** Its instructions say it drives the canvas's pull request, through tools
Ponzu acts on GitHub with as the person it works for: it opens the pull request itself once its
work is committed and worth a reviewer's look (ready for review in the turn its work is done, without
waiting for checks, which run after; a draft only when it stops partway), keeps the description current, watches checks and reviews,
fixes what fails and pushes, and keeps the branch up to date. It merges, or turns on auto-merge,
only when the person asked for that outcome (merge it, ship it, merge when green), never because
the work is finished: someone who asked for a change has not asked for it to land in their
main branch. A check, a review or a comment on GitHub never asks it to merge. They also say that a
failed push is Ponzu's to retry rather than something to work around, never to say it opened,
readied, updated or merged a pull request unless a tool's answer said it did, and to end a turn
on where the work stands: what is committed and on GitHub, and the pull request's number and
whether it is a draft, ready, waiting on checks or a review, or merged. Each turn starts with a
line after the event, from the claim's `pullRequest` and the last push: `(From Ponzu: no pull
request is open for <branch>. Open one with open_pull_request …)`, or `pull request #N is open …`,
and how many commits GitHub still lacks, with why the last push failed; a turn a check or a
review began adds that Ponzu won't merge, mark ready or turn on auto-merge in it. Against an API
whose claim does not say `pullRequest` (older than this), the line claims nothing about whether
one is open and points at read_pull_request, and the description tool's answer says only that no
open pull request took the words. The runner ships with the API ("The runner bundle"), so the
tools always find their routes; an API that answers one 404 is said as a refusal.

## Pull requests

A canvas has at most one open pull request, from its branch into its repo's default branch.
GitHub holds it. The canvas's row keeps the little the sidebar and the chrome show (number,
state, the checks rolled up, whether it can merge, auto-merge), clients watch that live, and the
pull request tab reads the rest from GitHub when it opens. The code is `apps/api/src/
pull-requests/` and `deps/github-pull-requests.ts`.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/v1/canvases/:id/pull-request` | none | `PullRequestTab` |
| GET | `/v1/canvases/:id/pull-request/files?path=` | none | one file and its diff |
| POST | `/v1/canvases/:id/pull-request` | none | 201 `PullRequestTab`; 200 when one was open; 202 while the sandbox pushes first |
| POST | `/v1/canvases/:id/pull-request/ready` | none | `PullRequestTab` |
| POST | `/v1/canvases/:id/pull-request/merge` | `{ headSha, bypass? }` | `PullRequestTab` |
| POST, DELETE | `/v1/canvases/:id/pull-request/auto-merge` | none | `PullRequestTab` |
| POST | `/v1/canvases/:id/pull-request/close?number=` | none (`number` optional) | `PullRequestTab` |
| POST | `/v1/canvases/:id/pull-request/update-branch` | `{ headSha }` | `PullRequestTab` |

Reading takes read access to the canvas; the rest takes write access. `PullRequestTab` is the
branch (`exists`, `aheadBy`, `behindBy` against the default branch, and `unpushed` and
`pushError`, the commits only the sandbox holds and why their last push failed, as its runner
last said), the pull request or null
(state, draft, mergeable and GitHub's merge state, review decision and reviews, every check with
its state, whether the repo's rules require it, and its link, the conversation (the last
hundred comments and reviews) with line comments, each saying whether its thread is resolved, the first hundred changed files with their
counts, the last hundred commits), `summary` (the agent's kept words on what the branch changes,
"Pull request summary", while no pull request is open: none yet, or the newest closed or merged;
null while one is open, since its description says them, or when the agent kept none), the merge
method Merge would use, whether the repo allows
auto-merge, and `nextAction`, the one thing the chrome's button offers: `create_pr` (the canvas
has commits its base lacks, on GitHub or only in its sandbox, and no open pull request, or
commits since its pull request merged), `ready` (a
draft), `resolve` (conflicts), `fix_checks` (a check failed), `auto_merge` (checks are running,
or the rules want a review, and the repo allows auto-merge), `update_branch` (the rules hold it
back for being behind), `merge`, `blocked` (the rules want something, a review or a required
check, and the repo has no auto-merge), or `none` (nothing to press: no changes, merged, checks
running in a repo without auto-merge, or GitHub still working out whether it can merge, as for
a few seconds after a push). Create PR is the API's, as the person
(`POST /v1/canvases/:id/pull-request`, above), like Ready, Merge, Auto-merge and Update branch.
Fix checks and Resolve are the agent's to do: the client sends it a message in the thread as
the person (which failing checks, or which base to merge in), once for a commit. Beside the
button, the Mac app's tab has a menu by the pull request's title, for anyone who can steer the
canvas, while it is open or a draft: Turn off auto-merge (`DELETE …/auto-merge`) while auto-merge
is on, and Close pull request (`POST …/close`), asked first ("Close #N without merging? The
branch and its commits stay. Create PR opens a new one later.") and sent with the number it
named, so a newer pull request opened meanwhile is never closed in its place (409
`pull_request_changed`). One that auto-merge merged meanwhile, before the API's read or between
that read and GitHub's close, is answered `pull_request_closed` ("#N is merged."), never
reopened. A closed pull request shows its closed
mark in muted and offers Create PR once the branch has commits its base lacks, and the tab shows
`summary` under "The description it opens with" whenever Create PR is offered. The tab is
reached from the chrome's pull request mark, so before the first pull request there is no tab to
show it on. A file's diff
is the unified patch, or `binary`,
or `too_large` past 512 KB or where GitHub gives none; only the hundred files the tab lists
are served, which is one request to GitHub. Everyone the tab names (an author, a reviewer,
whoever merged or turned on auto-merge) is `{ login, avatarUrl, bot, ponzu }`: `ponzu` marks
the Ponzu App's own bot, the canvas's agent, so a client never guesses it from a login's shape
(GitHub's GraphQL names a bot by its slug, its REST API as `<slug>[bot]`).

**What a client must not trust.** Every title, description, comment, review, check name and
notice title is what someone on GitHub wrote: anyone who can comment on the pull request, and
any app or CI that posts a check. It is GitHub's markdown, which can carry raw HTML (a
description carries Ponzu's own `<picture>`). A client renders it with raw HTML off, and
neither loads nor follows remote images in it (a tracking pixel learns who looked, and when).
The links the API sends (a check's page, an avatar) are http(s) or null: a check's link is
whatever its poster said, and anything else is dropped.

**Who acts.** The App reads the pull request and writes its description, each with a one-hour
token for the one repository and only what that needs (`contents`, `pull_requests`, `checks`
and `statuses: read` to read; `pull_requests: write` and `contents: read` to edit). Everything
else (open, ready, merge, auto-merge, close, update the branch) is done as a person, with their
own GitHub user token (`githubUserToken`): the person who pressed the button, or, when the agent
does it, the person its turn is for ("The agent's pull request"). The agent holds no GitHub
credential for any of it.

- Opened as the person, the pull request's author is whoever pressed Create PR, or whom the agent
  opened it for. GitHub never
  counts an author's approval of their own pull request, so where the repo's rules want one
  review, it comes from someone else, as it would without Ponzu. Opened as the App, the bot
  would be its author, and the sandbox pushes as the App too, so the person who asked for the
  change could approve it on GitHub and press Merge: one person where the rules want two.
- A user-to-server token acts with what both the person and the App may do. So GitHub holds a
  merge to the repo's rules exactly as they apply to that person, and not as they apply to the
  App, which a ruleset's bypass list could name. GitHub's history names the person
  (`merged_by`), not the bot.
- But GitHub lets an admin, or someone on a ruleset's bypass list, merge past what the rules
  still want. So Merge does not ask GitHub until the merge state is `clean`, `unstable` or
  `has_hooks`: anything else (a review wanted, a required check not passed, behind, unknown) is
  refused with its code before GitHub hears of it, and `nextAction` is never `merge` then. A
  client may offer to merge anyway only by asking the person and sending `bypass: true`; GitHub
  then decides whether they may. The agent never can.
- Reading needs no person, so a webhook can do it.
- Measured on the test repository with the App's permissions (contents and pull requests
  write; checks, statuses, metadata and members read): a person's token opens a pull request
  (its author the person), marks it ready (GraphQL `markPullRequestReadyForReview`), brings its
  branch up to date (`PUT …/update-branch`) and merges it (`PUT …/merge`, `merged_by` the
  person). Auto-merge is a setting of the repo, and where it is off GitHub refuses it to either
  token. Not measured: a base protected by rules, which takes the repo's administration
  permission to set up, and neither the App nor a token through it has that.
- A person whose GitHub token is dead is asked to sign in again (401 `github_reauth_required`).
- A canvas's link, `https://ponzu.design/canvases/<id>` (a pull request's description, the
  agent's messages), is a page of apps/web that hands the canvas to the Mac app as
  `ponzu://canvas/<id>`, or offers the app. `?page=<page id>` or `?artboard=<artboard id>` on it
  names one page or board, and rides along to the app. A link from before the rename still
  opens: the site sends `https://ponzu.design/designs/<id>` on to `/canvases/<id>` for good,
  query and all, and the app reads `ponzu://design/<id>` as `ponzu://canvas/<id>`. Nothing
  writes the old forms. Canvases made before the rename keep their `des_…` ids; new ones get
  `cnv_…`. The sandbox's tools give the agent each page's and board's link beside its id
  (`Workspace.linkTo`), and it links the ones it points the person at in its messages; the
  thread (`PlaceLink` in apps/studio) follows such a link in place, moving the view there, and
  opens another canvas's in the app.

**Opening** is a draft from the branch into the default branch, titled with the canvas's name,
whose description is the agent's summary, the canvas's first page as its preview showed it
(light and dark, through `<picture>`), and a link back to the canvas. The picture is a copy of
the previews made for that pull request, under a random key of its own
(`pull-requests/<key>/light.png` and `dark.png` at the bucket's root), which reaches those two
files and nothing else: a description outlives anyone's access to the repo, is mailed to its
watchers and is read by its integrations, and the canvas's asset key opens every file of the
canvas. Only a private repo's pull request gets one (whoever reads a public one need not be
able to open the canvas), and only once the canvas has previews. When a repo is made public,
the picture is taken out of each of its canvases' newest pull request's description and its
copy deleted from storage. What stays exposed: whoever could read the description has seen the
first page as it was, a mail or an integration may keep a copy, and an earlier pull request of
the same canvas (one closed, or merged before the canvas was reopened) keeps its picture.

**Commits only the sandbox holds.** When the runner has said the branch has commits GitHub
lacks, Create PR asks it to push them: a `push` event (priority `now`, which wakes a sleeping
sandbox), with the last push's error cleared, since this is a new try. When GitHub has
something to open the pull request from, it opens at once and the push brings the rest; when it
has nothing yet, the answer is 202 with the tab, and the person's client reads the tab every few
seconds and asks again once GitHub has the commits, or says the runner's reason when the push
fails, or gives up after three minutes. The person never has finished work and no button.

Where the repo's plan has no draft pull requests GitHub refuses one, and a ready one is opened
instead. Asking again answers the pull request already open from the branch, or the merged one
until the branch has commits since its merge (the canvas was reopened and worked on), when a
new one is opened from the same branch; one someone opened on GitHub from the branch into the
default branch is the canvas's too; after one is closed, asking opens a new one. Refused:
Scratch (409 `no_repository`), a branch not on GitHub with nothing in the sandbox to push
(`branch_not_pushed`), a branch with nothing the default branch lacks (`no_changes`).

The agent's summary sits between `<!-- ponzu:summary -->` and `<!-- /ponzu:summary -->`, and
only that part is written again. A description someone rewrote without those markers is theirs:
the summary then waits, unwritten.

**Reading, and keeping the row in step.** One GraphQL query as the App (`PULL_REQUEST_QUERY`)
reads the branch and the pull request; the newest pull request from the branch into the default
branch is the canvas's. One from a fork never is, and nor is one someone pointed at another
base: it merges nothing into the default branch, so it neither shows nor settles the canvas.
Every path that reads one (the tab, an action, a webhook) records what it read through one
function, `recordRead`: the row, the thread's notice (written once, by an id of its own), and,
on a merge, the canvas settling. So a merge from the button and GitHub's webhook for it settle
the canvas once, whichever comes first, and the sandbox's teardown follows from the settled
state. Reads finish out of order and a check finishing leaves GitHub's `updated_at` alone, so a
read is recorded only over one that began no later (`canvases.pr_read_at`), or over an older pull
request; a merge is the last word on its pull request, and a canvas reopened after its merge
stays open. A read that finds what the row already says writes nothing, since every write
reaches everyone watching the workspace's canvases.

GitHub's pull request lags a push to its branch by a second or so, and until then shows the
old commit with its checks and mergeability. The query reads the branch's commit with the pull
request, and a read that shows an open pull request at another commit than its branch is not
recorded (a green tick for a commit nobody checked), unless it is the last read there will be;
Merge and Update branch refuse it as `head_moved`.

A webhook is a signal to read again, never a record: `pull_request` (opened, closed, reopened,
synchronize, edited, ready, back to draft, auto-merge on and off), `check_run` (completed and
re-run; one starting adds nothing the push's read does not see), `check_suite` (completed),
`pull_request_review`, and `push`. Each read is a GraphQL point of the installation's 5,000 an
hour, and GitHub sends a delivery for every check that finishes, so deliveries are folded into
windows of two seconds (`pull-requests/refresh.ts`): the first about a canvas in a window
records one read for the window's end as a job (`pull_request.refresh`, keyed by the canvas and
the window) and makes it then, the rest find it recorded, and the cron tries again a read that
failed. A read is made again at one, two, three and four seconds while the pull request lags its
branch or GitHub is still working out whether it can merge (`mergeable` is null; the spike
measured four to eight seconds after a push or a change of base). A push to the default branch
reads the open pull requests of the repo's canvases, the fifty updated last, four at a time,
since it may have given them conflicts. Whether checks pass is the rollup of check runs and
commit statuses, never check suites: other apps leave theirs queued for good.

**Acting** refuses what it can name before asking GitHub, and says why GitHub refused with a
code a client can show, from GitHub's own words where it gives them. Merge uses the first of
squash, merge and rebase the repo allows (GitHub has no default method of a repo's own; squash
is what most allow). It takes the commit the person looked at (`headSha`, required, as for
Update branch) and merges only while the branch is still there, waiting up to three seconds
while GitHub works out whether it can. After GitHub says it merged, it is read until the read
shows it, for a few seconds; if it still does not, a job reads it again a minute later, so the
canvas settles whether or not the merge's webhook arrives.

| Code | When |
|---|---|
| `no_pull_request` | nothing is open to act on |
| `pull_request_closed`, `pull_request_draft` | merged or closed; a draft, for a merge or auto-merge |
| `pull_request_changed` | a close named a pull request that is no longer the canvas's newest |
| `head_moved` | the branch has commits since `headSha`, or moved under the request |
| `mergeability_unknown` | GitHub is still working out whether it can merge |
| `merge_conflicts` | the branch conflicts with its base |
| `review_required`, `changes_requested` | the repo's rules want an approval; a reviewer asked for changes |
| `checks_failing`, `checks_pending` | a check the rules require failed, or has not finished (other checks may fail) |
| `branch_behind` | the rules want the branch up to date: update it |
| `branch_protected` | the rules refuse it for a reason GitHub does not give (signed commits…) |
| `branch_up_to_date` | updating a branch that has everything its base has |
| `auto_merge_not_allowed`, `already_mergeable` | the repo has auto-merge off; nothing is left to wait for |
| `forbidden` | GitHub does not let this person do it (403) |
| `workflow_permission` | it would change a file under `.github/workflows/`, which the App may not (422) |
| `merge_queue` | Merge on a repo with a merge queue while Ponzu does not add to one (409) |
| `merge_queue_unmergeable` | the merge queue turned the pull request down (409) |
| `github_refused` | anything else GitHub refused (422) |
| `turn_not_from_person` | the agent's merge, ready or auto-merge in a turn no person in Ponzu began (403) |
| `agent_limit` | the agent did this as often as an hour allows (409) |

**Merge queues.** The tab's query reads whether the pull request's base merges through a merge
queue (`isMergeQueueEnabled`) and its entry while it is in one (`mergeQueueEntry`: its state and
place), and the tab carries both as `pullRequest.mergeQueue`. On such a repo GitHub refuses a
direct merge, so Merge never asks for one, and never past the queue whatever `bypass` says.
While `PONZU_MERGE_QUEUE` is off (every deployment until enqueueing is proven against a real
queue) Merge answers `merge_queue`: "This repository merges through a merge queue. Add it to the
queue on GitHub." With it on, Merge adds the pull request to the queue as the person
(`enqueuePullRequest` with `expectedHeadOid`, the commit they looked at), answers it queued, and
GitHub merges it once the queue's checks pass; the merge then reaches Ponzu as any other does. A
pull request in the queue offers no action (`nextAction` is `none`; taking it out of the queue is
GitHub's), Merge pressed again changes nothing, and one the queue turned down is
`merge_queue_unmergeable`. The agent hears the same: what holds its merge back
(`merge_queue`, `merge_queued` with its place, or `merge_queue_unmergeable`), and, with the switch
on, that it added the pull request to the queue, never that it merged it. GitHub may refuse the
two queue fields alone to an App without its "Merge queues" permission, which Ponzu's tokens do
not ask for; the tab then reads as if there were no queue rather than failing, and a Merge goes to
GitHub, whose queue refuses it. Whether GitHub does refuse them to Ponzu's tokens is not proven.

**Workflow files.** The App has no `workflows` permission, so GitHub refuses any push, branch
update or merge from Ponzu that would change a file under `.github/workflows/`, in its own words
("refusing to allow a GitHub App to create or update workflow … without `workflows`
permission"). The runner tells that refusal apart from the others (`workflow_permission`, never
tried again) and the thread says: "GitHub won't let Ponzu push changes to files under
.github/workflows/ to {repo}: Ponzu's GitHub App isn't allowed to change workflows. {commits} on
{branch} are safe in this canvas's sandbox. Ask Claude to leave workflow files out of this
canvas's commits, or change them on GitHub yourself." The agent is told up front to leave
workflow files out of its commits, and its pull request tools stop before asking GitHub when its
push was refused this way. Update branch and Merge answer `workflow_permission` when GitHub's
refusal names workflows. What status GitHub answers a branch update with in that case is not
proven against GitHub: the code goes by its words, whatever the status. Granting the App
`workflows: write` would lift all of it, and is the founder's choice.

**Lost webhooks.** A sweep in the minute's cron (`cron/steps/pull-request-sweep.ts`,
`pull-requests/sweep.ts`) reads again the open pull requests (and drafts) nobody has read from
GitHub for fifteen minutes, oldest read first, at most 20 a minute, by recording the same
`pull_request.refresh` job a webhook would (keyed `sweep:<canvas>:<window>`), which the next
minute's jobs make. It leaves out a canvas with a read already waiting, one already swept in the
current fifteen-minute window (a quiet pull request's read changes nothing, so it stays among the
oldest), and one whose workspace has no working installation. That is at most 20 GraphQL points
a minute across every installation; a merge on GitHub whose webhooks were all lost settles its
canvas within about sixteen minutes. Each run that records reads logs `pr_swept` with the count.

**Two at once.** A person pressing Merge while the agent merges (or two people, or auto-merge
landing first) go to GitHub with the same commit, and GitHub merges once. The other's merge is
refused, and the action reads the pull request again: merged, it answers the tab as it is (the
person's client shows it merged; the agent's tool says it was already merged, by whom, and that it
did not merge it). Everything else is already idempotent: opening answers the one open, ready
answers a pull request already ready, auto-merge one that has it on.

### The agent's pull request

The agent drives its canvas's pull request: it opens it, reads where it stands, marks it ready,
updates its branch, turns on auto-merge and merges it. It holds no GitHub credential for any of
it. Its tools, hosted by the runner beside `describe_pull_request` on a repo canvas whose
repository is checked out (`apps/runner/src/pull-request-tools.ts`), ask the API, and the API does
exactly what the person's own route does, through the same code (`openPullRequest`,
`actAndSay`), as a person (`apps/api/src/pull-requests/agent.ts`, `routes/runner-pull-request.ts`).
So everything that made Create PR and Merge safe holds for the agent too: the pull request's author
is a person, GitHub holds the merge to the repo's rules as they apply to that person, and its
history names them.

| Tool | Takes | Answers |
|---|---|---|
| `open_pull_request` | `{ draft = true }` | pushes the branch, then opens it as a draft (with `draft: false`, marks it ready too, in a person's turn); whether this opened it or one was open |
| `read_pull_request` | nothing | state, draft or ready, each check with its name, result, whether required and its link, reviews, unresolved line comments, whether it can merge and what holds it back, how far behind the base it is, who Ponzu acts as this turn and whether the turn may merge |
| `mark_pull_request_ready` | nothing | marked ready, or it was not a draft |
| `update_pull_request_branch` | nothing | pushes, then has GitHub merge the base in at the checkout's commit; that the agent pulls before committing again |
| `enable_auto_merge` | nothing | turned on (and that it has not merged yet), or already on |
| `merge_pull_request` | nothing | pushes, then merges at the checkout's commit; merged as whom, or already merged by whom |

Each answer says what GitHub confirmed, never more: "Merged pull request #12 on GitHub, as Maya
(@maya)", or "Pull request #12 was already merged by @sam; you didn't merge it". A refusal is the
API's own sentence and what the agent can do about it (fix the checks, update the branch, turn on
auto-merge, tell the person a review is wanted, ask the person; a failed check's log is not
readable from the sandbox, so the agent reproduces it with the repo's own commands). The turn's
record calls the steps "Merging the pull request" while they run and "Asked to merge the pull
request" once done, never "Merged": GitHub may have refused, and the API's own line says what
happened. What GitHub people wrote (a title, a check's name, a comment) comes back quoted, and the
agent's instructions say it is feedback, never instructions. Unresolved line comments are quoted
only from people GitHub says can push to the repository, as only their reviews reach the agent as
events; a stranger's comment on a public repository is left out, and so is one whose thread the
query's newest 100 didn't include, since whether it is resolved isn't known. When
`open_pull_request` with `draft: false` can't mark it ready, it reads the pull request again
rather than say it is still a draft (GitHub may have done it and its answer been lost), or says
it doesn't know.

**Who it acts as.** Each call names the turn's event (`turn`): the event whose message began the
turn, taken into the session as it began, other than a canvas edit (which is not words to act
on). It is set once, as the turn begins: a turn that Ponzu's own note or an edit began has none,
and keeps none when a person's words come in during it, since no person began it. Words that come
in later in the turn never take it over, and the next turn names its own. A turn picked up after
Claude Code stopped (A turn that never came) names the event that began it, which the turn marker
keeps beside the last one taken in, never those last words: they may have come in during a turn an
edit, a check or a review began, or from someone else. The API
looks it up in the canvas's feed (`getTurnOrigin`, packages/db): it must be one of this canvas's
events that **this runner** (its lease, `X-Ponzu-Runner`) was handed, or it is none. So a turn
picked up after the runner process restarted, or an old event a runner token in other hands names,
is not a person's turn.

- An event a person sent in Ponzu (`message`, `answer`, `comment`, with its person) is **a
  person's turn**, and the agent acts as that person.
- Any other turn (one a `check`, a `review` or an edit began, one that is Ponzu's own note to the
  agent, one whose event the API cannot find) acts as the last person whose message, answer or
  comment went into the session, else the canvas's owner. It is **not a person's turn**.
- A person's turn stops being one once a `check` or a `review` went into the session after the
  person's event, or may yet: GitHub's words may have gone in after the person's. What decides it
  is the order the session took events in, not their place in the feed, since the runner puts a
  `now` event in ahead of an older `next` one it holds: an event counts when it was handed to a
  runner and is not acknowledged (it may still go in, and an acknowledgement on its way never lets
  it through), or was acknowledged (`delivered_at`) no earlier than the person's event. The same
  moment is one batch of acknowledgements, whose order isn't known, so it counts; before the
  person's own acknowledgement arrives, one already acknowledged went in ahead of it, as the
  runner acknowledges in the order the session took them.
- It stops being one, too, once a message, answer or comment from **anyone else** went into the
  session after it, or may yet, by the same order: the request is no longer one person's, and a merge would
  be done as, and credited to, someone who may not have asked. More from the same person keeps
  it theirs. An answer to a question the agent is waiting on goes into the turn that asked, so it
  never begins one, and someone else's answer ends the turn's claim like their comment would.
- So a person's ask counts in the turn it began and only while nothing from GitHub or anyone else
  came in after it. When something did, the agent says so and the person asks again, or presses
  the button in the pull request tab.

Then that person must still be allowed: `requireCanvas` with write access, as for steering the
canvas (a member of the workspace whom GitHub lets push to the repository, asked again when the
kept answer is old), and a GitHub user token Ponzu can use. Refused, the tool says so in words the
agent repeats: "Ines can't change this canvas's repository on GitHub now …, so Ponzu won't act as
them" (403 `forbidden`), or that their GitHub connection lapsed and they need to sign in again
(409 `github_reauth_required`: never 401, which a runner takes as its own token being dead).

**Guardrails, in code.**

- **Only a person's turn lands it.** `ready`, `auto-merge` and `merge` in a turn that is not a
  person's are refused (403 `turn_not_from_person`) before anything else. Any turn may read, open,
  update the branch, push and describe: a failed check or a review can be fixed, never merged.
  Text from GitHub is not the person, whatever it says. Auto-merge, once a person's turn turned
  it on, is GitHub's: it lands what the branch holds when the repo's rules pass, including
  commits a later turn pushed, as it would for anyone who pushes to the branch. The repo's rules
  (required reviews, dismissing stale approvals) are what hold those commits.
- **Never past the repo's rules.** The agent's routes take no `bypass` (the body is strict: one
  sent is 400), and the merge is sent with `bypass: false`, so it merges only when the merge state
  is `clean`, `unstable` or `has_hooks`, as the button does; otherwise the agent gets the reason
  (`review_required`, `checks_failing`, `branch_behind` …) and `read_pull_request`'s
  `mergeHold` says it before it asks.
- **What it merges is what it has.** Merge and Update branch send the commit the checkout is at,
  after the runner pushes what GitHub lacks; a branch that moved on GitHub is `head_moved`.
- **In the thread, every time.** Each thing the agent did is a `pull_request_agent` notice naming
  the person it acted as, written by the API when GitHub confirmed it, never by the runner. A
  merge GitHub took but does not show yet gets none: GitHub's own line says it once it does.
- **A few an hour.** Per canvas, counted from those notices (by the API's clock in each): opening
  3, ready 5, updating the branch 6, auto-merge 5, merging 3. Past one, 409 `agent_limit`; a
  person's own buttons are not limited. The count is read before GitHub is asked and the notice
  written after, with no lock, so calls made at the same moment can go one or two past a limit;
  it is there to stop a loop, not to count exactly.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/v1/runner/pull-request?turn=evt_…` | none | `PullRequestStanding` |
| POST | `/v1/runner/pull-request/open`, `/ready`, `/auto-merge` | `{ turn }` | `AgentPullRequestAnswer`: the standing, `did` (this call did it) and `pushing` (open: the runner was asked to push first) |
| POST | `/v1/runner/pull-request/update-branch`, `/merge` | `{ turn, headSha }` | the same |

Each holds to the lease. Safe to repeat: what is already done answers `did: false` (already
open, ready, merged, auto-merge already on), and only a call that did something writes its
notice. Two answer 409 instead, as the person's routes do: Update branch on a branch already up
to date (`branch_up_to_date`), and auto-merge on one that can merge now (`already_mergeable`);
the tool says what each means.

Create PR and the action button work as before, as the person who presses them, beside the
agent's calls; a person can always do what the agent was refused.

## Assets and previews

Bytes live in R2. Each canvas has a random asset key; its files are served from
`https://assets.ponzu.cloud/<asset key>/…`. Images, CSS and video cannot send an
`Authorization` header, so the key in the path is the capability. The API returns
it only to people who can open the canvas, and it can be rotated.

User content is served from its own domain, `ponzu.cloud`, so nothing a canvas
contains ever shares an origin or a cookie with `ponzu.design`.

The runner uploads a light and a dark preview of the first page after each batch of
edits. The sidebar and the phone show those.

Under a canvas's asset key:

| Key | What |
|---|---|
| `assets/<name>` | a file of the canvas, as markup references it |
| `previews/<seq>-light.png`, `previews/<seq>-dark.png` | the previews of `canvases.preview_seq` |
| `exports/<upload id>-<name>` | a file an export link reaches |
| `comments/<message id>-<theme>-<random>.webp` (`.png` from the iPhone) | the picture of where a comment was left, in each theme |

At the bucket's root, `pull-requests/<key>/light.png` and `dark.png` are a pull request's
picture, copied from the previews when it opens, under a random key that opens nothing else
("Pull requests").

A client builds a preview's address from the canvas's head: `<assets url>/<asset key>/previews/
<preview seq>-<theme>.png`. A preview waits under `staging/` at the bucket's root until it is
completed with its seq, and is copied into place then; a bucket lifecycle rule can clear what is
never completed. Previews replaced by later ones are deleted. A comment's picture waits there too,
since it is uploaded before its comment is saved (and may never be): it is copied under
`comments/` only when it is attached to a comment that exists and has no picture yet.

A canvas's files can be deleted together: the job `canvas.files_delete`, keyed by the asset key,
lists what is under `<asset key>/` (ListObjectsV2) and deletes it a thousand keys at a time
(DeleteObjects), up to 2,000 an attempt, coming back ten seconds later while more remain, for at
most ten attempts. The helper behind it (`deleteUnder`, `apps/api/src/canvases/files.ts`) refuses
any prefix that is not exactly a well-formed asset key followed by `/`, before it asks storage
anything, so no bug can turn it on another canvas's files, on `pull-requests/` or on the whole
bucket.

Deleting a canvas (`DELETE /v1/canvases/:id`) and deleting an account (the canvases that go with
it, "Deleting an account") go through the same purge, `deleteCanvasAndFiles`: one statement
deletes the canvas's row and records that job, keyed by the asset key the row had as it went, so
the row is never gone without the job that deletes its files. The request then runs the job at
once, past its answer; a function that dies first leaves it to the minute's cron. An upload
address signed before the delete can still land bytes under the key until it runs out, so once
the key is empty the job comes back for one last pass, fifteen minutes after the delete (the
upload address's ten minutes, with five over), and deletes whatever came late. That pass has an
attempt of its own, an eleventh, so a purge that needs all ten still gets it. A canvas
deleted twice finds no row the second time and records nothing. A pull request's pictures are
not under the asset key and stay: its description on GitHub still shows them.

**Resetting a canvas's file links.** A link to a canvas's file works for whoever holds it, and a
link can get out (pasted in a chat, kept by someone who has since lost access). The canvas's
owner or an admin of its workspace can reset its file links, from the foot of Share ("Reset file
links", with a confirmation: "Reset this canvas's file links? Links to its images and exports
stop working, including any you've copied or pasted elsewhere. Everyone who can open the canvas
gets the new ones."). `POST /v1/canvases/:id/asset-key/rotate` (403 `forbidden` for anyone else)
makes a new asset key and:

1. copies every object under the old key to the new one;
2. swaps the canvas's `asset_key`, only if it is still the old one, and moves
   `canvases.asset_key_rotated_at` (in the head), recording in the same statement the job
   `canvas.asset_key_retire`, keyed by the old key, due fifteen minutes later;
3. copies again whatever the old key gained or changed during the first pass;
4. answers the canvas as `GET` does, with its new `assetsUrl`.

The job runs once every upload address signed for the old key has run out (ten minutes, with
five over): while the canvas is still under the new key it copies once more what changed under
the old key since the first pass began (all the second pass covers, so a second pass that failed
loses nothing), then deletes everything under the old key, a page at a time as the files delete does. Neither that
copy nor the second pass writes over a file that was written under the new key after the one
under the old key, so a file the runner replaced since the swap keeps its newer version: each
copy reads the new key's file again just before it copies. That narrows the race to one round
trip to storage and does not close it, since storage is not asked for a conditional copy. A
canvas reset again within the fifteen minutes gets what came late to the old key under its
current key instead, and only what changed there since the swap, so a file deleted under the
middle key stays deleted. A canvas deleted after the swap has its files job take the new key at once; the retire job then deletes
whatever the second pass still copied into the new key after that. An upload
completed after the swap is moved under the new key as it completes. Two resets at once make
one: the second finds the key changed, answers the canvas as the first left it, and its copies
are deleted by a `canvas.files_delete` job. A failure before the swap changes nothing anyone can
see. Clients watch the head's `assetKeyRotatedAt`: when it moves, the open canvas asks
`GET /v1/canvases/:id` for the new address and draws from it, and the sidebar asks again for the
row's previews. A runner already awake keeps the old address until it next starts, so for up to
fifteen minutes after a reset it reads files through a key about to go, and past that it cannot
read them until its next start. Resets are on demand only; nothing resets a canvas's links when
someone loses access.

Neither a delete nor a reset clears a cached copy. Previews, exports and comment pictures are
served `immutable` for a year and assets for five minutes, so Cloudflare's edge, and a browser
that already opened a file, can keep answering with a copy after the object is gone from R2,
for as long as they keep it. Nothing asks Cloudflare to purge its cache yet: that needs a
Cloudflare API token with cache purge rights and a seam for it, and is not built.

Uploads are signed (SigV4, by aws4fetch in `apps/api/src/deps/storage.ts`) for their type,
exact size, SHA-256 (`x-amz-checksum-sha256`, which R2 checks against the bytes), cache rule
and disposition, for ten minutes; completing one checks that storage holds that size and checksum. Kinds and sizes:
assets are the images, fonts and videos `add_asset` takes, up to 20 MB; exports PNG, JPEG or
PDF, up to 50 MB; previews PNG, up to 5 MB; a person's upload an image, up to 20 MB.

An SVG can run script when a browser opens it by itself, so it is stored with
`Content-Disposition: attachment`: opened directly it is saved, not shown, and as an `<img>` or
a CSS `url()` (which run no script) it draws as ever. Object storage cannot attach a
Content-Security-Policy to an object; a response header rule on the assets zone could add one
(`default-src 'none'; style-src 'unsafe-inline'; sandbox`) as a second wall.

## Ideas

Under the create composer, up to four prompts for the chosen repo ("Make checkout one page, with
the order summary on the right"). They are generated, never written by hand
(`apps/api/src/ideas/`).

- **Ponzu pays.** Claude Haiku 5.5 (`claude-haiku-5-5`) writes them, and Claude Sonnet 5.5
  (`claude-sonnet-5-5`) checks them (the gate, below), both on Ponzu's own
  `PONZU_ANTHROPIC_API_KEY`, not the person's Claude account: a subscription token cannot make
  direct API calls, and the ideas show before anyone has connected Claude. The name is not
  `ANTHROPIC_API_KEY`, which is the person's own key in a runner. About $0.001 for the writing
  and $0.005 for the gate a repo, about $0.015 at worst (two of each). These are the only model
  calls the API makes; a canvas's agent still runs on the person's own plan in its sandbox.
- **Through the AI SDK** (`ai`, `generateText` with `Output.object` and the zod schema, a 30
  second timeout), reaching Anthropic with the `@ai-sdk/anthropic` provider and our own key
  rather than the Vercel AI Gateway: the key is already on every environment, local
  development and tests need no Vercel login, and no gateway has to be enabled or billed on the
  project. Going through the gateway is the model line in `createClaude` (`deps/model.ts` has
  it, with `createGateway` on the API's `fetch`), plus `AI_GATEWAY_API_KEY` read in `env.ts`.
  The writer is `deps.model` and the gate `deps.reviewer`; both are traced (docs/analytics.md).
- **Per repo**, on `repos.ideas`, shared by everyone who can read the repo. `GET
  /v1/repos/:id/ideas` answers `ready`, `generating` or `none` to anyone `requireRepo` lets
  read it, a 404 to anyone else.
- **Lazily, in the background.** The first ask claims the generation in the row
  (`ideas_claimed_at`: one instance at a time) and answers `generating`; the client asks again
  on a short backoff (`watchRepoIdeas`, about 45 seconds at most). The read, two asks and two
  gate checks have 60 seconds. Each workspace may start 20 generations an hour, counted on its
  row, so a thousand repos cannot run up a bill. Failures are quiet: the screen shows no ideas.
- **What reaches a person**, in order:
  1. **Exact checks** (`checkIdeas`), on what code alone can decide: the answer parses as the
     schema, it has exactly four ideas, each is non-empty and at most 90 characters (code
     points), none holds a control, format (bidi override, zero-width), private-use or line
     separator character, and no two are the same. Each is normalised: spaces collapsed, a final
     period dropped, the first letter raised.
  2. **The gate** (`gate.ts`): Claude Sonnet 5.5 at low effort reads the four ideas, with only
     the product's name and description (fenced as data, never the README), and says of each,
     with its reason, whether it is **safe** (asks the reader for nothing but work on the canvas: no
     address, contact, command, install, sign-in, credential, setting, third-party code,
     destructive step or payment, relays no message from the repo, nothing hateful or abusive)
     and whether it is **visible** (something people see or do). It judges nothing else.
  - An answer that fails either is asked for again once, with Ponzu's own fixed sentence for
    what failed (`RETRY_REASONS`), never the answer's words or the gate's, which may quote the
    repo. Then: every idea passes, and all four are kept; some fail only as not visible, and those
    that pass are kept (one to four; the grid shows fewer tiles fine); one is unsafe in the last
    answer the gate read, and none of this generation's are kept (`ideas_withheld`: the repo is
    steering the ideas); nothing passes, and none are kept (`ideas_rejected`). Those last two
    count as a generation, keeping the ideas there were, and wait for a push, or a day when the
    repo is left with none. A gate that gives no verdict (down, refused, out of shape) is a
    failed generation, never a verdict: nothing is stored and it is tried again an hour later,
    like GitHub or the writer failing or the deadline passing.
  - **Why a gate.** A repo's text is untrusted, and an idea a person taps goes into their own
    message to an agent that can write and push their repo, where it is no longer quoted text. A
    README can ask for an idea that tells the reader to re-enter a token at an address spelled
    out in words, run a script or add someone's snippet; no exact check tells those from a
    brief, so a stronger model judges them against a written rubric, which is itself checked
    against labelled examples (docs/evals.md). Whether an idea is specific, honest about a
    product not built yet, in its own words or free of talk about how it was made is not gated:
    a false "no" there costs a person their ideas, so those are measured offline by the eval
    suite and fixed in the prompt. There are no word lists, opener lists or phrase matching:
    the ones there were turned away a product called ponzu-test for a week and let a spelled-out
    address through.
- **Retries, two layers:** the SDK tries a 429, a 5xx or a dropped connection once more, and an
  answer that fails a check or the gate is asked for once more. At most two asks and two gate
  checks, eight HTTP requests, a generation.
- **Refresh**: ideas are made again when the repo's default branch moves. GitHub's `push`
  webhook for it stamps `repos.default_pushed_at`, and the next ask after that (an hour at least
  after the last try) starts a generation; the ideas there were show meanwhile, and the new ones
  the next time the page opens. A push to any other branch, a canvas's own included, changes
  nothing they were made from; those are known only from the repo list's `pushed_at`, which
  remakes ideas a month old (and catches a default-branch push whose webhook never came), and an
  empty list after any push. A visit alone never remakes them, and a repo nobody pushes to keeps
  them. The one exception is a change in how ideas are made: each list keeps the version that
  made it (`repos.ideas_version`, `IDEAS_VERSION`), and an empty list an earlier version wrote is
  made again at the next ask, push or not (version 3 is the one that replaced the pattern rules
  with the gate). And an empty list (nothing kept, with none from before) is made again a day
  on, push or not: a repo with little in it is the kind nobody pushes to.
- **A light read, never a clone**, through Octokit as the App with a token for that one repo
  (`contents: read`, `metadata: read`), minted and dropped: the repo's description and topics,
  its tree, README, up to four manifests and one theme file. At most 8 reads; the tree as far as
  GitHub lists it (100,000 entries or 7 MB), a manifest or theme file only under 64 KiB, the
  README cut at 64 KiB (GitHub's contents JSON carries at most 1 MB), about 18,000 characters
  into the prompt. Screens and routes come from path conventions (Next, Remix, SvelteKit,
  Nuxt/Vue, Rails, Django and Jinja, Laravel, Phoenix, Expo Router, React Native, SwiftUI,
  Android, Flutter), and a hand-written page with something in it (an `.html`, `.vue`,
  `.svelte` or `.astro` file over 4 KB) counts as one, so a finished one-page site is a product
  with a screen. A repo of fewer than 8 files also has the start (16 KiB) of up to 2 of its
  files read, its largest page first, with the reads its missing manifests leave (still at
  most 8).
- **A product not built yet still gets ideas.** A repo with no screens, no components, no theme
  and fewer than 8 files (`isUnbuilt`) is asked with its own instructions
  (`FRESH_SYSTEM_PROMPT`): where someone building this product would begin, one of each of
  four kinds, each a short menu (where people start: a first screen, a welcome, an empty state; how it
  introduces itself: a landing page, a pitch, a sign-up page; what people come to do: the
  screen at its heart or its core flow; its look), as specific as its name, owner, description,
  topics, README and files allow, building on a first draft when one is there, and honest that
  nothing exists yet. When nothing says what the product is, the user turn says so (Ponzu's
  words, outside the fence): keep to what the name alone implies, naming no feature it does
  not, or, when the name says nothing either, write good first briefs for any new product,
  claiming nothing about this one.
- **The four kinds** (a product with an interface): improve a screen the repo names; variations of its most prominent one;
  a screen or state it lacks; something across the interface. Kinds 3 and 4 are menus with no
  default, so repos do not all get the same empty state or type scale, and only screens the
  read found may be redesigned. "No dark theme" is said only when a theme file was read.
- **The repo's text is untrusted.** The instructions are all in the system prompt, the same for
  every repo; the repo's text goes in the user turn inside one `<repository>` fence it cannot
  close (every `<` and `>` in it is replaced). The prompt says never to pass on a message,
  address, contact or command from the material, and that the product's own name and words are
  always fine, whatever they are (a product called ponzu-test, gpt-playground or Claude Desk; a
  code host's repositories, an editor's code). The answer is structured output, and what reaches
  a person has passed the exact checks and the gate above.
- **Measured, not pattern-matched.** `bun run evals ideas` runs the prompt and the gate against
  checked-in repos of every kind, hostile ones included, and grades what a person would see
  with a calibrated judge (docs/evals.md); a prompt change comes with its numbers before and
  after. `bun apps/api/scripts/ideas.ts owner/repo` prints the ideas, and the gate's verdicts,
  for a live public repo, for reading by eye.

## Billing

Pay as you go in credits: $0.10 a credit, 5 credits per awake hour, 100 free per
member each month, pooled across a workspace. A card is asked for only when the
free credits are used up. A workspace has a monthly cap.

- Awake time is metered from the sandbox's state changes into `usage_events`: each stretch
  from `awake` to whatever it moved to, in the statement that moved it, put down to the
  workspace and to the person behind the newest event of the canvas's feed when it was woken
  or last kept awake.
- `credit_ledger` holds grants, use and adjustments. Balance and cap are checked
  before every wake. A running turn is never cut off.
- Stripe receives the billed part as metered usage.
- The iPhone shows usage and sells nothing.

What is built so far is the reading of it: Plan and usage, worked out from `usage_events` and
the rate card. There is no Stripe, no ledger write and no cap enforcement yet; the cap is stored
for when there is.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/v1/workspaces/:id/usage` | none | `WorkspaceUsage` |
| PATCH | `/v1/workspaces/:id/billing` | `{ capUsd }` | `WorkspaceUsage` |

**The period.** A workspace's anchor is the day it was made (`billing_period_anchor`). Its
period starts at midnight UTC on that day of every month, or on the month's last day when the
month is shorter (a workspace made on the 31st starts on February 28), and ends where the next
starts (`billing/period.ts`). `period.end` is the day Plan and usage "bills" or "resets" on; an
app formats it in UTC, or a person west of Greenwich reads the day before. A stretch of awake
time counts in the period it began in, as its usage event is dated, and the stretch awake right
now counts up to the moment of asking, under the card in effect.

**The arithmetic** is one module, `billing/credits.ts`, and every number it answers is an
integer:

- Used credits: awake seconds × the card's credits per awake hour ÷ 3,600 (each stretch priced
  by the card that was in effect when it began), plus what model turns cost (zero while every
  canvas runs on its owner's own plan), added up exactly and rounded down to a whole credit. A
  partial credit, under twelve minutes awake at 5 an hour, is never charged.
- Free credits: the card's free credits per member × the people counted, pooled. The people
  counted are everyone who has been a member at any point in the period, plus anyone else whose
  use is in it. A member's allowance is granted once a period and never taken back: it is a
  `grant` row in `credit_ledger` for the period's start (`credit_ledger_grant_key` keeps it to
  one), written for every member the first time Plan and usage reads the period with them in
  it, and for a person as they leave (a sync that drops their membership, or deleting their
  account, whose grants stay with no person). So the count is the members now, everyone with a
  grant for the period, and everyone whose use is in it, and someone who leaves mid-period
  without using anything still counts. Only people who have signed in are members, so a
  collaborator who never signed in adds nothing.
- Billed credits: used − free, never below zero. Billed cents: billed credits × what a credit
  sells for, rounded down. The apps work dollars out of these: the headline to the cent, the
  legend in whole dollars rounded down.
- A breakdown (by person, by canvas) is the rounded total shared out, not each part rounded on
  its own, so its lines always add up to the headline: every line gets its exact use rounded
  down, and the credits the fractions add up to go one each to the lines with the largest
  fractions (largest remainder, ties by id; `apportion` in `credits.ts`). It is gross, before
  the pooled free credits, so it adds up to what was used, not to what is billed. Use put down
  to nobody (a deleted account) is `unattributedCredits`, one of the by-person lines. The
  viewer's own line (`mine`) is their share only where it sits beside the by-person list it adds
  up with; to someone who sees just their own line it is their own use rounded down, so other
  people's use never moves it.
- The cap is whole dollars, $1 to $1,000,000, stored in cents (`monthly_cap_cents`; the card's
  default, $100, until one is set). It may not be set below what the period has billed, rounded
  up to the dollar (400 `cap_too_low`, with `details.lowestUsd`).

**Who sees what.** Every member sees the totals, the free credits, what would be billed and the
cap, and their own use (`mine`). An admin also sees `byPerson` (everyone counted, highest
first), `unattributedCredits` and `byCanvas`: canvases named only where they may read the repo
(or their own Scratch, `kind: "canvas"`), then canvases since deleted in one entry with no canvas
(`kind: "deleted"`), then the canvases they may not know of in another (`kind: "hidden"`). An admin who reaches the workspace only through repos shared with them sees no other
member here either. Only an admin sets the cap (403 `forbidden`). `billing` answers
`{ status: "not_set_up", card: null, invoices: "not_set_up" }`, so the apps show the no-card
state.

## Notifications

Settings › Notifications chooses what pings a person and where. What Ponzu tells a person is
a row in their inbox (`notifications`), which the Mac watches live; a push to an iPhone is a
delivery of that row (`notification_deliveries`), sent through Expo's push service. Every
event in "What is worth a ping" below writes those rows and sends its pushes (see "Sending");
billing's trigger is built and waits for billing to call it. Pushes stay off until
`EXPO_ACCESS_TOKEN` is set: without it every planned push is cancelled as `push_off`, and the
inbox, the Mac's banners and the badge work regardless.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/v1/me/notifications` | none | `{ prefs, devices, badge, email: { address, available }, timeZone }` |
| PATCH | `/v1/me/notifications` | some of `prefs`, and `timeZone?` | as GET |
| POST | `/v1/me/notifications/:id/read` | `{ via: "mac" \| "ios" }` | 204 |
| POST | `/v1/me/devices` | `{ platform, pushToken?, pushEnvironment?, installId, name?, appVersion?, blocked? }` | 201 `{ device }`, 200 when it was theirs already, 409 `push_token_taken` |
| PATCH | `/v1/me/devices/:id` | `{ pings?, blocked?, name?, appVersion?, pushToken? }` | `{ device }` |
| PUT | `/v1/me/devices/:id/active` | none | 204, 404 for a device not theirs |
| DELETE | `/v1/me/devices/:id` | none | 204 |

`badge` is the number on the Mac's dock and the phone's icon: the person's needs-you
notifications whose question is still open, across every workspace, read or not and whether
or not pings are on. `email.address` is where the daily email would go and `email.available`
says whether this deployment can send it at all (false until `RESEND_API_KEY` is set, and
Settings hides the Email row while it is). `timeZone` is the IANA zone the app last reported,
null until one has; the app sends `timeZone` in a PATCH when its own differs, and a name the
API's time zone data does not know, or a bare offset such as `+05`, is a 400. The daily email's 9:00 is in that zone.

`PUT /v1/me/devices/:id/active` is a heartbeat: the person is at this install now (a Mac with a
window focused and input in the last two minutes, a phone in the foreground). Apps send it every
60 seconds while that holds. It moves `active_at` and `lastSeenAt`, and skips the write when the
last one is under 30 seconds old. A phone's ping waits two minutes for a person at their Mac,
which shows it at once. `POST /v1/me/notifications/:id/read` is the app that showed a
notification saying it was read: a Mac's banner clicked or a phone's ping tapped. Reading again
keeps the first reading, and an id that is not the person's changes nothing; the answer is 204
either way, so it says nothing about whose an id is. Looking at a canvas reads the rest:
`POST /v1/canvases/:id/seen`, sent while the person's presence on the canvas says it is focused
(within the last 75 seconds), also marks every notification the person had about the canvas,
made up to that moment, read (`via: seen`). Sent from a window left open in the background, it
reads none of them, so a question raised there still reaches the person's phone. A needs-you
stays on the badge until its question closes, read or not.

The inbox is the live query `me.notifications` ("Realtime"): the person's unread notifications
and every needs-you whose question is still open. A row carries ids, a kind, a title (the
canvas's name, or the workspace's), Ponzu's own sentence as the body, a `link` (`open` is
`thread`, `pull-request`, `comment` or `usage`, with page, artboard, comment thread and question
ids), a `count` for a teammate's comments folded into one row, and `muted` when the person's
toggle for the kind was off. Never anything a person or the agent wrote.

Presence (`PUT /v1/canvases/:id/presence`) also takes `focused`: true while the person's window
is focused and showing the canvas, false when it stops, left out to keep what it was. A
presence row focused in the last 75 seconds means the person is looking, and nobody is pinged
about what they are looking at. The client sends a change at once, not at the next beat.

`prefs` is `{ needsYou, replies, prReady, teammateComments, emailDigest }`, on the person's row:
the first three start on, the last two off, as the board draws them. A toggle saves as it is
flipped and every device reads the same row. A device is an install of the app, one row per
person and install. An iPhone (`ios`) sends `pushToken`, its Expo push token exactly as
`getExpoPushTokenAsync` gave it (`ExponentPushToken[…]` or `ExpoPushToken[…]`), and
`pushEnvironment`, which APNs it is for; pushes go through Expo's push service, which holds the
APNs key. A Mac (`macos`) sends neither, and a 400 refuses one that does: it shows its own
notifications while the app runs. The database holds the same rule (an iPhone row has a token,
a Mac row has none). The iPhone registers after the person turns notifications on, and again
at each launch, which updates the row in place and keeps `lastSeenAt`; it asks, registers and
reports nothing while `GET /v1/me` says `features.push` is false (docs/mobile.md, "Pings"); a new token from the
same install replaces the old one on the same row. `installId` is the app's own random id for
the install (16 to 64 letters, digits or dashes), made once and kept (in the Keychain on the
phone), and never returned. A token another person
registered moves to whoever registers it now, with pings on, only when the same install
registers it (the phone signed in as someone else; logged `device_token_moved` with both
people). From any other install it stays where it is and the answer is 409 `push_token_taken`
(logged `device_token_conflict`): knowing a token is not enough to take someone's pings. `pings` is the person's toggle for one device;
`blocked` is the phone saying iOS has notifications for Ponzu off, which the app reports and
Settings shows as "Turned off in iOS Settings". A person keeps twenty devices; registering a
21st forgets the one unseen longest. Signing out of the phone deletes its device. No answer
carries a push token back.

**Sending.** Product code calls `notify(trigger)` (apps/api/src/notifications/notify.ts) with
ids only. It records a `notify` job keyed by the trigger and runs it at once, past the
response; the minute's cron runs one whose request died. The job reads the facts, works out who
hears of it, and writes one inbox row per person, each with a dedupe key (`needs_you:<canvas>:
<question>`, `reply:<canvas>:<turn>`, …) that one person never gets twice, however often the
trigger comes. Its words are Ponzu's own sentences in `copy.ts`: the title is the canvas's name,
and the body never holds a question's, comment's or the agent's words, a repo, a branch or a
path. Then the quiet rules (`plan.ts`) choose the pushes:

1. A toggle that is off keeps the row, `muted`, and pushes nothing.
2. Someone whose presence on the canvas was focused in the last 75 seconds is looking: the row
   is read at once (`looking`) and nothing is pushed.
3. More than 20 pushes to a person in an hour, needs-you and billing aside: the Mac only.
4. Every iPhone with `pings` on, not `blocked`, with a token and seen in the last 90 days gets a
   delivery. It goes now, or two minutes on when one of the person's Macs was active in the
   last two minutes (the Mac shows it first).

Each notification's pushes are a `notification.deliver` job, keyed by the notification, run
when the first is due. At send time a delivery is cancelled, with its reason, when the row was
read (`read`: a banner clicked, the canvas looked at, the question answered by this person), a
needs-you was resolved (`resolved`), the toggle went off (`pref_off`), the phone is gone, off or
blocked (`device_off`), the person can no longer read the canvas by their kept access answers
(`access`), the row is more than 30 minutes old (`stale`), or push is off (`push_off`). The rest
go in one request. A push is marked `sending` before the request and is never sent twice:
Expo's 429 puts it back to wait 30 seconds; a 5xx or no answer may mean Expo took it, so it
stays `sending` and the cron marks it `unknown` five minutes on. Every push carries a collapse
id (its notification's, or `<canvas>:comments` for a teammate's comments), so one that arrives
twice shows once. A ticket's `DeviceNotRegistered` forgets the phone if it still holds that
token. The cron reads receipts from 15 minutes after a push: `delivered`, `failed` with Expo's
code (a `DeviceNotRegistered` forgets a phone not seen since the push), or `unknown` after a
day with none. A push's `data` is `@ponzu/core/push` version 1, ids only.

When a question closes (answered, withdrawn, or found closed by the cron), its needs-you rows
are resolved and whoever answered has theirs read. Each person whose badge went down gets one
badge-only push 30 seconds on (`notification.badge`, keyed by the person, so a burst is one
push); so does a person whose new needs-you pushed nothing. Every ten minutes the cron reads
unread rows past three days as `expired`, deletes rows past 30 days, and forgets iPhones unseen
90 days and Macs unseen 30.

**On the Mac.** Nothing is pushed to a Mac. While Ponzu runs, the studio watches
`me.notifications` and shows Electron's own notification for a row (`app/notifications.ts`,
with its rules in `cloud/notify.ts`), and sets the dock's number to `badge`, counted from the
same rows: needs-you rows whose question is still open, read or not, shown whether or not pings
are on. A row shows a banner when it is unread, not `muted`, not a needs-you whose question has
closed, not shown already this launch, made no more than 60 seconds before the app opened and
no more than ten minutes ago (so opening the app to fifty old rows shows none), this Mac's
`pings` is on, and the person is not looking at its canvas. A row about the canvas in front of
the person (the window focused and visible, the canvas open) is read instead, `via: mac`. A
teammate's comments folding into one row replace its banner rather than add one. A banner goes
when its row is read, its question closes or the row leaves the inbox. Clicking one brings
Ponzu forward and follows its link: the canvas with its thread open on the question, its pull
request tab, or the comment on its pin; a billing ping opens Settings › Plan and usage. Then the
row is read, `via: mac`, which also cancels the phone's push still waiting its two minutes. At
each launch and sign-in the studio registers this install as a `macos` device (its install id,
made once and kept in the app's data folder, and the computer's name as macOS shows it, or its
host name without `.local`), trying again a minute later when the API could not be reached,
sends the heartbeat every 60 seconds while the person is at it and at once when the window
comes to the front, and sends its time zone once when it differs from the one kept. Signing out
from the sidebar deletes this Mac's device first; signing out from the menu leaves it to be
forgotten after 30 days unseen. Either way the main process takes every banner away, from the
screen and Notification Center, and clears the dock's number, so whoever signs in next sees
none of them. Settings › Notifications › Where lists the person's Macs and iPhones,
this one first as "This Mac", and the Email row only while `email.available`. macOS shows an
app's notifications only when the app is signed: Ponzu Local's are refused, which the studio
logs once and goes on.

**What is worth a ping**, and who gets it. Each goes to the person's devices with `pings` on
and not `blocked`, never to the person who caused it, and speaks as Ponzu. Someone who can read
or steer a canvas is judged from their kept access answers for its repo (write or admin to
steer, read to read; one older than a day counts as no), and is checked again when the ping
goes.

| Event | Kind | Toggle | Who | When |
|---|---|---|---|---|
| A question for you | `needs_you` | `needsYou` | the canvas's owner and whoever is driving it, at once, if they can steer it; five minutes on, if it is still open, everyone else who can steer it and has opened it | the runner raises a question (`POST /v1/runner/questions`): a question, a plan, a permission, details, a link to open or a secret |
| A reply | `reply` | `replies` | the commenter whose comment began the turn | the runner reports the turn completed |
| A canvas finished | `finished` | `needsYou` | the person whose message or answer began the turn | the turn completed after more than a minute of work and left no question open |
| A turn that failed | `failed` | `needsYou` | that turn's person, in words that say why | the runner reports it failed (not at a Claude limit) |
| A message that lapsed twice | `failed` | `needsYou` | the person who sent it | its copy went unanswered too, and the thread asks them to send it again |
| A canvas that would not start | `failed` | `needsYou` | whoever's message, answer or comment waits on it, else its owner | a wake gave up (`sandbox_failed`), or its runner stopped answering too many times in a row |
| A Claude plan limit | `claude_limit` | `needsYou` | whoever's Claude account the canvas runs on | once a day per account |
| A pull request is ready | `pr_ready` | `prReady` | the canvas's owner, and the pull request's author when they are a member | `recordRead` records it open, not a draft, checks passing and mergeable; once per head commit, and at most once per canvas and person every 30 minutes |
| A pull request approved | `pr_approved` | `prReady` | the canvas's owner and the pull request's author, never whoever approved it | a review that approved it, from someone GitHub says can push to the repo; once per review |
| A teammate comments | `teammate_comment` | `teammateComments` | the canvas's owner | a person other than the owner comments on it. A comment within ten minutes of the owner's unread comment ping for the canvas folds into it ("Maya and Sam left 3 comments.") and the phone's ping is replaced, not added to |
| Billing | `billing_free_used`, `billing_cap_warning`, `billing_cap_reached`, `billing_payment_failed` | always | the workspace's admins (for a personal workspace, only its person: the member whose GitHub account it is, never a collaborator), who must still be one when it goes | billing calls `notify({ kind: "billing", workspaceId, periodStart, notice, amountCents })` on a change of its gate; once a period each, in billing's words ("Northbrook has used 80% of this month's $100 cap.") |

A failed check, changes asked for, a stop, a lapse being sent again and a stalled runner ping
nobody: the agent takes the first two up by itself, and the rest recover on their own. Nothing
calls the billing trigger yet; billing does once its gate is built.

**The daily email** (`emailDigest`, off until the person turns it on) is one email a day of
the same events and nothing else, sent through Resend (`deps/mail.ts`, the official `resend`
SDK). It is off for everyone until `RESEND_API_KEY` is set, and Settings hides the Email row
until then. `PONZU_EMAIL_FROM` is who it is from, `Ponzu <ping@ponzu.design>` unless set.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/v1/email/unsubscribe?t=` | none | a page saying the email is off; 400 and a page saying the link doesn't work |
| POST | `/v1/email/unsubscribe?t=` | anything (a mail app's one-click unsubscribe) | 204; 400 `invalid_request` |

Every five minutes the cron's `digests` step records an `email.digest` job, keyed
`digest:<user>:<local date>`, for each of up to 20 people whose email is on, who has an
address, for whom it is 9:00 or later in their time zone (the app's, or America/New_York when it has reported none or
one Postgres does not know), and whose `digest_sent_on` is before that local date. The job reads
their notifications from the 24 hours before it was found due that are still unread (`muted` ones
included: they were never pinged), leaves out needs-you rows whose question has closed, and groups them by canvas, with billing rows under
their workspace. A canvas whose person is no longer a member, or whose kept access answer has
changed to less than read since its newest row, is left out (an answer that is only old is not:
the email is for people who have been away); a billing row goes only to someone still among the
workspace's billing recipients. With nothing left it only stamps `digest_sent_on`. Otherwise it
sends one email and stamps the date. The step runs its batch itself, one email after another,
rather than leaving it to the minute's `jobs` step, which takes ten jobs a minute of every kind:
a busy 9:00 never holds pushes up, and Resend's rate is not met all at once.

The subject counts what it holds ("Ponzu: 3 things on 2 canvases", "… and your plan" with
billing rows). The body is each canvas's name (or the workspace's) and under it the rows' own
sentences, at most ten a canvas and then "And 2 more.", each linking to
`https://ponzu.design/canvases/<id>` with `open`, `page`, `artboard`, `question` and `comment`
riding along, which the site's page hands to the app as a `ponzu://canvas/` link; a billing line
has no link. There is a plain text part, and `List-Unsubscribe` with
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`. The job's key is Resend's idempotency key,
so a send retried within a day is not sent twice. Resend's 429, 5xx or no answer tries again five
minutes on; a refusal (a bad address, an unverified sender) or a key already used is logged and
the day is stamped. Logs carry the person's id and Resend's codes, never the address or the words.

The unsubscribe link carries `t`: the person's id and that id sealed by the vault under
`email-unsubscribe/<user id>`, so only the API can make one, one person's does not open as
another's, and all it can do is turn that person's email off. It does not expire. Following it
turns `emailDigest` off and answers a page ("You won't get Ponzu's daily email any more."); the
POST does the same for a mail app and answers 204. Either is safe to repeat, and the person can
turn the email on again in Settings.

## Repo environments

Settings › Environments shows, per repo, the base its canvases start from and the secrets its
sandboxes receive. A repo is listed once it has something to show: a base, a rebuild asked for,
or a secret.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/v1/workspaces/:id/environments` | none | `{ repos: Environment[], canManageSecrets }` |
| GET | `/v1/repos/:id/environment` | none | `{ environment, canManageSecrets, canRebuild }` |
| POST | `/v1/repos/:id/environment/rebuild` | none | 202, as GET |
| POST | `/v1/repos/:id/environment/secrets` | `{ name, value }` | 201, as GET |
| PUT | `/v1/repos/:id/environment/secrets/:name` | `{ value }` | as GET |
| DELETE | `/v1/repos/:id/environment/secrets/:name` | none | as GET |

`Environment` is the repo (`id`, `owner`, `name`, `fullName`), its base (`status`: `none`,
`building`, `ready` or `failed`; `builtAt`; `stack`, each a Simple Icons slug and a label;
`rebuild`: when one was asked for and whether its job still waits) and its secrets by name with
when each last changed. Anyone `requireRepo` lets read the repo sees it; anyone else gets a
404, a repo of the same workspace included. Anyone who can push to the repo may ask for a
rebuild; only an admin of the workspace adds, replaces or removes a secret (403 `forbidden`).

**Rebuild** records a `repo.base_rebuild` job, keyed by the repo, and answers at once. The
sandbox side of building a base (Claude setting the repo up again from its default branch, the
result saved as its snapshot and its stack written down) is not built, so the job's handler is
only a mark: `repos.base_rebuild_requested_at`, for the repo's next start to act on once it can.
Canvases that have a sandbox keep it.

**Secrets.** A name is capitals, digits and underscores, starting with a letter, at most 64
characters; a value is 1 byte to 16 KiB with no NUL; a repo holds at most 50, 44 KiB of names
and values in all, because they all go into one start command's environment, which Ponzu caps at 64 KB (Linux
refuses one variable of 128 KiB), in base64, which is a third larger, beside Ponzu's own (409
`secrets_full`). A name that would
replace or steer what Ponzu puts there, or change how a program loads code or checks TLS, is
refused (400 `secret_name_reserved`): anything starting `PONZU_`, `CLAUDE_`, `ANTHROPIC_` (a
second credential, or `ANTHROPIC_BASE_URL` sending the owner's to someone else), `ASCII_` (an
old sandbox provider's), `GIT_` (the credential helper is Ponzu's), `LD_` or `DYLD_` (the
loader's), `BUN_` (`BUN_OPTIONS` is flags, `--preload` among them), `NODE_` or `NPM_CONFIG_`
(but `NODE_ENV` and `NODE_AUTH_TOKEN`, which only say how the repo's own code runs and
installs), and `BASH_` (`BASH_ENV`, exported functions); and `PATH`, `HOME`, `USER`, `LOGNAME`,
`SHELL`, `PWD`, `TMPDIR`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `PS4`, `IFS`, `PROMPT_COMMAND`,
`PYTHONSTARTUP`, `XDG_CONFIG_HOME`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`,
`REQUESTS_CA_BUNDLE` and the proxy variables. Adding a name
the repo has is 409 `secret_exists`; replacing or removing one it lacks is 404. The value is
sealed in the vault bound to `repo_secrets.encrypted_value` and `<repo id>/<name>`, and is
never returned, logged or put in an event or a question. A secret the agent asks for in the
thread goes to the same row (`answerSecretQuestion`, from `POST
/v1/canvases/:id/questions/:questionId/secret`; "Needs you") and the question keeps only its
name. That name comes from the sandbox, so the runner's question route and the answer route
both check it with these routes' rule, and the sandbox's environment checks it again either way.
Unlike these routes, it takes write access to the canvas rather than a workspace admin.

**Into the sandbox.** `newEnvironment` (`sandboxes/environment.ts`) opens the canvas's repo's
secrets, read in one statement, and packs them into one variable of the start command's `env`,
`PONZU_REPO_SECRETS`: `NAME:base64(value)`, comma-separated (`encodeRepoSecrets` in
`@ponzu/runner/protocol`). They never become variables of the runner's own: the runner is a Bun
process that holds the runner token and the Claude credential, and a variable like
`BUN_OPTIONS` would load code into it before it starts. The runner unpacks them only into the
environment of what it starts for the agent (`agentEnv`), under its own variables, so none can
stand in for those either, and without the runner token. Base64 also means the variable holds
nothing a shell could read as a command whatever an admin typed (a quote, `$(…)`, a newline in
a PEM). A Scratch canvas has none. It never fails a
wake: a name that is reserved now (one stored before it was) and a value the vault cannot open
are left out, and anything past the 64 KB is too, each logged by count only. A changed secret
reaches a canvas at its sandbox's next wake, since every start makes its environment anew; a
runner running now keeps the values it started with.

## Deleting an account

`DELETE /v1/me` with `{ confirm }`, the person's GitHub login typed out (any case; 400
`confirmation_mismatch` otherwise), answers 204 once the account is gone, and the app signs out.
While the person is the only admin of a workspace that others are in it is refused, 409
`sole_admin` ("Make someone else an admin first.") with `details.workspaces`, and nothing
changes: a workspace always has an admin. That is an organization's workspace, and their own
account's too when collaborators on their repos are in it: it still bills, and someone must be
able to set its cap. The check is made first, and again in the statement that deletes the row,
on the admins' membership rows locked, so two admins deleting themselves at once cannot each
see the other stay; the second is refused there, after the steps before it, which are safe to
have taken.
There is nothing else to change about a profile: a person's name, avatar and email are GitHub's
and change there, coming through at their next sign-in.

In this order, each step safe to repeat, so a request that fails partway can be sent again:

1. Their Claude credential is destroyed, and every awake sandbox started with it is put to
   sleep (as disconnecting does).
2. Every sandbox of a canvas they own is retired, its awake time metered and its runner tokens
   revoked: its row is held, the sandbox is deleted at Vercel in the background, and the sweep's
   reconcile removes what that misses.
3. Their canvases that are theirs alone are deleted with everything under them: their Scratch
   canvases, and their canvases in a workspace nobody else is in. Each goes through the same
   purge as deleting one canvas ("Assets and previews"): its row and the `canvas.files_delete`
   job for its asset key in one statement, the job run at once, so its stored files (assets,
   previews, exports, comment pictures) are deleted too. A pull request's pictures stay with
   the pull request on GitHub. The canvases that stay with a workspace keep their files.
4. Their name is taken out of what stays: in every canvas of a workspace they are in, or that
   they own, a thread item they wrote or stopped a run in names them as
   `{ name: "Deleted user", login: "ghost" }` (GitHub's own name for a deleted account) under
   their old id, and their ops' actor is "Deleted user" with no picture. Their words stay.
5. This period's free allowance is granted to them in every workspace they are in, so their
   leaving does not take it back ("Billing").
6. Their grant of the GitHub App is revoked at GitHub, so Ponzu leaves their GitHub
   authorizations and every token of theirs ends: `DELETE /applications/{client_id}/grant` with
   the App's client id and secret as Basic auth and their token (refreshed first if it has run
   out) in the body, while the token is still stored. It is best effort and inline: a person
   with no token has nothing to revoke, a grant GitHub no longer has (404) is done, and any
   other answer, no answer, or more than 10 seconds is logged as `github_grant_revoke_failed`
   (their id and GitHub's status, never the token) and the deletion goes on. The
   `github_app_authorization` webhook that follows finds nobody and does nothing, or, if it
   comes before their row is gone, forgets the token and ends the sessions that step 7 ends
   anyway. If step 7 then refuses (another admin's deletion left them the only one), the grant
   is already revoked: they keep their account and sign in again.
7. Their row is deleted, and with it everything that hangs off it: their sessions (so every
   token of theirs stops working at once), GitHub token, memberships, repo access answers,
   Claude account, devices and open sign-ins. What other people's work points at forgets them:
   a canvas's owner, who wrote a thread item, who answered a question, who changed a secret,
   whom usage is put down to (the workspace's usage history stays, put down to nobody).
8. A job, `account.forget` (keyed by their user id, ten attempts over about six hours), forgets
   them outside Ponzu, recorded in the same statement that deletes their row (so the row never
   goes without it) and run at once (`apps/api/src/account/forget.ts`). It deletes
   their WorkOS user, so their next sign-in is someone new (a user WorkOS no longer has is done,
   and one that a new account signed in with before the job was recorded is kept). While the
   job waits, sign-in refuses that WorkOS user as `account_being_deleted` (409), so no account
   is made on it between the job's check and its delete. It then asks PostHog to delete their person with its events and recordings:
   `POST {PONZU_POSTHOG_API_HOST}/api/projects/{PONZU_POSTHOG_PROJECT_ID}/persons/bulk_delete/`
   with the personal key as the bearer and `{ distinct_ids: [userId], delete_events: true,
   delete_recordings: true }`. PostHog takes it at once and deletes in batches later, usually
   within about a week. A failure at either is tried again; the WorkOS delete is safe to repeat.
   Without `PONZU_POSTHOG_PERSONAL_API_KEY` and `PONZU_POSTHOG_PROJECT_ID` the PostHog step is
   skipped, logged as `analytics_forget_skipped`, and the job completes. The `account deleted`
   event is captured about no one, so it does not make their PostHog person again.

**Canvases they own in a workspace others are in stay with it**, owned by nobody: a team's, or
their own account's when collaborators on their repos are in it. Their boards, thread and pull
request are work shared with people in a repo they reach, who have commented on it and may be
about to merge it; deleting them would take that from people who did not ask, and
GitHub, which holds the branch and the pull request, keeps them either way. They run on nobody's
Claude now, so they do not wake (`claude_owner_left`) until a teammate takes one over (below);
until then they can be read, commented on, merged and deleted by an admin. The delete dialog
says so: "Your canvases, threads and settings are deleted. Canvases in a team stay with the team.
Your repos and pull requests on GitHub are not touched."

**Taking over a canvas whose owner left.** A canvas runs on its owner's Claude alone, and never
switches accounts while its owner is in its workspace. Once its owner has left the workspace, or
deleted their account (`owner_id` null), anyone with write access whose own Claude is connected
may take it over: `POST /v1/canvases/:id/take-over`. No other canvas qualifies, and an admin is
asked the same as anyone. In one statement the canvas's `owner_id` and `claude_account_id`
become the caller's and their connected account's, a wait on the last owner's Claude
(`agent_blocker` starting `claude_`) is lifted while any other wait (billing, paused) stays, and
the thread gets an API-written notice `{ type: "owner_changed", by }` under `ti_owner-<random>`.
The statement holds on the owner still being gone and the canvas still having the owner it was
read with, so of teammates pressing at once one takes it, and a take-over racing the owner's
return happens whole or not at all. Then, as when Claude is connected, it wakes if its feed
holds work no runner took. A sandbox still awake, whose runner was started on the last owner's
credential, is put to sleep first (the sweep would no longer stop it, since the canvas now runs
on a member's Claude), and the same rule wakes it after. Its next runner starts with the new owner's credential and resumes
the same Claude session from the disk or the checkpoint; the runner does not change. Refusals:
409 `not_ownerless` while its owner is a member (they came back, or a teammate took it first;
a head that still said `claude_owner_left` for an owner who came back is lifted, and woken if
work waits), and 409 `claude_not_connected` when the caller has no Claude that could run it
(none connected, revoked, or past its sign-in). Analytics: `canvas taken over`. The Mac's
composer says "Its owner left the workspace. Take it over to run it on your Claude." with a
"Take over" button to someone who can, and otherwise "Its owner left the workspace, so nobody's
Claude runs it. Someone who can change {owner/name} can take it over."; the thread line reads
"{Name} took this canvas over. It runs on their Claude from now on.", and Share shows the new
Owner. Whether an admin alone should take over is the founder's to confirm; it is one check in
the route.

What is not rewritten: the name a canvas's document carries for a comment's author (inside the
op and the checkpoints, whose history is not rewritten), and their words in workspaces they had
already left.

## Search

Search looks through one workspace at a time, in the canvases the person may read there, on
Postgres with the `pg_trgm` extension. It finds:

- canvas names, page names and board names;
- comments, open and resolved;
- people's messages in a canvas's thread, and the agent's answer of each turn that ended with one
  (`turn.final`);
- pull request titles and numbers, every pull request a canvas has had;
- the workspace's people who have joined Ponzu, by name or login.

It does not find words drawn on boards, notes, asides, tool steps, repo or branch names, or
anything in another workspace. Each of those would be another kind in the same table.

**The table.** `search_entries (canvas_id, kind, ref, text, folded, context, author_kind,
author_id, author_name, at)`, one row per thing that can be found, keyed by `(canvas_id, kind,
ref)`. The kinds are `canvas`, `page`, `board`, `comment`, `message` and `pull_request`. `text` is
what the person sees, cut at 8,000 characters; `folded` is the same text folded for matching
(lower case, accents taken off, punctuation as spaces) in TypeScript (`@ponzu/core`'s
`foldForSearch`), keeping its length, so match offsets carry straight back to `text`. A GIN
`gin_trgm_ops` index covers `folded`, and a second, partial one covers the name kinds.
`search_state (canvas_id, version, indexed_seq)` says which version of these rules last rebuilt a
canvas's entries. Entries go with their canvas when it is deleted.

**Written by the statement that changes their source:**

- A commit (`POST /v1/canvases/:id/ops`, and undo and redo) carries what changed in the
  document's entries (`docSearchChanges`), worked out on the same documents as the commit, in the
  same statement and gated on the canvas's seq moving, so a conflict or a replay writes nothing.
  Ops search never reads (the agent's node edits, mostly) send no search SQL at all. A removed
  entry is left with empty text, which is never a hit.
- A canvas's create writes its document's entries, its first message's, and its `search_state`.
- A person's message is indexed by the statement that posts it.
- The agent's answers are indexed after the runner's thread write, in a statement of their own:
  for each turn that write ended with a `final`, that answer, as plain text (its markdown taken
  off with `mdast-util-from-markdown`). This never fails the runner's write: a failure is logged
  as `search_index_failed`, with ids alone, and queues a reindex of the canvas. An answer that
  is not in the thread yet, or is still streaming there, when its turn's ending arrives (the
  runner may send the two in separate writes) also queues a reindex, which finds it once it lands.
- A pull request's read writes `#<number> <title>` when that text changed.
- A person who deletes their account keeps their entries' author id, and is shown as "Deleted
  user" by the failed join to `users`; the stored name is rewritten too, and a later commit or
  reindex writes "Deleted user", never the name a document's comment still carries.

**Reindex and backfill.** The job `search.reindex` (key: the canvas id) rebuilds one canvas's
entries whole. It reads the document, replaces its document's entries in one statement that
holds the canvas row at that seq (`FOR UPDATE`), so a commit either waits for it or moves the seq
and the reindex reads again; after three tries it is retried 30 seconds later. Then it writes the
thread's entries page by page: people's messages, each ended turn's answer (and takes out any
other answer of that turn), and answers from before turns had records. When an ended turn's
answer is still streaming or not in the thread yet, it writes what there is and is retried 15
seconds later, until the answer lands or the job's attempts run out. The cron step
`search_backfill` queues it for canvases with no `search_state` or an older version, the most
recently active first, with at most 25 waiting at once so other jobs are not held behind it.
Raising `SEARCH_VERSION` rebuilds every canvas this way.

**Access.** One rule, `readableCanvases`, serves both the canvas list and search: the canvas is
in the workspace, the person is a member of it, and it is either their own Scratch canvas or one
in a repo `repo_access` says they can read. Search therefore never finds a canvas the sidebar
would not list. Before searching, the route brings the person's repo access up to the minute
exactly as the list does (`refreshWorkspaceRepoAccess`), so a repo they lost leaves search when
it leaves the list.

**The route.** `POST /v1/workspaces/:id/search`, with `{ q, groups? }`. It is a POST, not a GET,
so the words never sit in an address that a request log or a proxy keeps. `q` is 1 to 200
characters after trimming (400 `invalid_request` otherwise); `groups` picks among `canvases`,
`boards`, `comments`, `messages`, `pullRequests` and `people`, all six when left out. A
non-member gets the same 404 as an unknown workspace. A query of punctuation alone answers
nothing, with 200. The answer holds at most 8 canvases, 8 boards (pages share the group), 8
comments, 8 messages, 4 pull requests and 4 people, each with the match offsets into the text it
shows, and for comments and messages a snippet round the first match. A pull request's state is
given only for the canvas's current one. Authors are a person (as their row is now), the agent,
or `deleted`. No asset key, preview address, repo or branch is in an answer: clients draw those
from the canvas list they hold and drop a hit on a canvas it does not list.

**Matching and ranking.** The query is folded as the text is and split into terms (at most 8);
quoted words are a phrase. Every term must match. A term of 3 or more characters matches
anywhere in the text; a shorter one only at the start of a word, and comments and messages are
searched only when some term has 3 or more characters, so "ui" alone searches names. `%`, `_` and
`\` are never wildcards: they fold to spaces. Within each group hits rank by tier (the whole text,
or a pull request's number; the text starts with the query; every term at a word start;
anywhere), then by recency (the entry's own time, else the canvas's last activity), then by id.
People are matched in TypeScript over the people GitHub would show the searcher, joined members
only, ranked the same way, then admins, then by name.

**What it logs and sends.** One log line, `search`, with the workspace id, `ms`, `access_ms`,
`query_ms`, the number of terms, the query's length and the count per group, and the server
event `search answered` (docs/analytics.md). Never the words.

**Speed.** The targets: the search statement at p50 20 ms and p95 50 ms for a workspace of up to
100,000 entries; the route without a GitHub refresh at p95 150 ms; a commit that carries search
changes no more than 5 ms slower. `packages/db/scripts/search-bench.ts` measures the statement;
`search.live.test.ts` checks in CI that a 3-character term's plan uses the trigram index. What
has been measured, on Postgres 17 and 18 on a loaded Mac, is in "Known constraints".

**On the Mac.** ⌘K asks for every group (people only in an organization's workspace) and shows
them as Canvases, Boards, Comments, Messages, Pull requests and People. A result opens where it
is: a board or page on the canvas, a comment at its pin, a message in the thread's rail (paged
back to, at most 20 pages, and marked a moment), a pull request on its tab, and a person as the
sidebar's filter. apps/studio/src/cloud/README.md "Search" has the details.

**On the iPhone.** The Search tab asks for canvases, boards, comments and messages, and shows
them as Canvases, Boards and Threads (comments and messages together, newest first, at most 8). A
board opens in focus on its page, a comment at its pin with its thread open, and a message with
the chat sheet up at it. Until the answer comes, and whenever the API can't give one (no network,
an error, or a 404 from an API without this route), the phone matches the canvases it already
holds by name with the same text rules, and Boards and Threads don't show. docs/mobile.md
"Search" has the details.

## Clients

**Desktop.** The shell bundles the studio and serves it from a custom scheme
(`ponzu-studio://app`, the one origin outside the web that the API's CORS allows),
so the app and its UI always match. The main process owns sign-in, token storage
(`safeStorage`), refresh and the updater; the renderer asks it for an access token.
Every client names itself on each request (`X-Ponzu-Client: macos/2.0.0`). The API
can refuse one that is too old (426, `client_too_old`), and the shell then offers
the update.
On first launch the cloud app removes what 1.x left behind (the wake helper, the
`ponzu` shim, agent registrations), each only when it is in the form 1.x wrote and
what it runs is gone.

The renderer never holds the refresh token: it borrows an access token from the
main process for each request (`borrowSession` in `packages/client`) and sends
the request itself, from the studio's origin. The window shows the studio and
nothing else, under a content security policy that runs only the studio's own
script and reaches only the API, Neon Realtime and a canvas's files (each its
environment's exact host), and, in a build that reports usage, its PostHog project's ingestion
host ([analytics.md](analytics.md)). A canvas's images may come from any https host, as they
do in the runner's previews. The packaged app's Electron fuses refuse to run it as
Node or open an inspector, and a release refuses a remote debugging port, so no
other program can run code as Ponzu to read the session. Signing out forgets the
session and everything the studio kept: the canvases last opened and their asset keys,
and clears the dock's number. The bridge's notification channels (`ponzu:notify:show`,
`:remove`, `:badge` and `:failed`) show a banner, take banners away, set the dock's number
and report a banner macOS refused; the main process checks what the studio sends as it would
anything (ids, words of at most 200 characters, a link that is exactly one of ours), keeps up
to 50 shown notifications so their clicks still arrive, and hands a click's link to the
studio as it would a `ponzu://` link ("Notifications", "On the Mac").

Links into the apps, one grammar for every client (`packages/core/src/links.ts`,
`@ponzu/core/links`):

```
ponzu://canvas/<canvas id>?page=&artboard=&open=thread|pull-request|comment|usage&question=&comment=&message=&n=
ponzu://github/setup?result=installed&workspace=<workspace id>
ponzu://auth/callback?code=&state=                       the iPhone's sign-in only
ponzu://billing/card?setup=<setup id>&result=added|cancelled
ponzu://settings?section=usage|notifications|account&workspace=&n=
```

`n` names the notification a link came from (a Mac's banner, a phone's ping), so opening it
reads it; a billing ping's link is the settings one, to Plan and usage, and names its
workspace, so the app shows that workspace's plan whichever one the window was showing.

A link only asks to show something; one that doesn't parse is dropped, and an optional
part that isn't an id is left out. Ids are `[A-Za-z0-9_-]{1,64}`. `ponzu://design/<id>`
is read as the canvas link, for good. A development build takes `ponzu-dev://` instead,
so it never takes an installed app's links. A ping carries ids only, as `PushData` v1
(`@ponzu/core/push`), and a tap goes where `linkOfPush` says, through the same grammar.

**Studio** keeps the canvas as it is. `Canvas` depends only on the `CanvasSource`
interface; `CloudSource` in `packages/client` implements it on a `Replica`. The
shell around the canvas is new: guided setup, the sidebar, the thread, needs you,
the pull request tab, settings, sharing and presence.

**Mobile** is the same client on the same packages. Signing in, workspaces, the
canvases list, the canvas, comments, the thread and answering questions. Push
notifications are new work on both sides.

The canvas draws every on-screen board as live DOM. The local app also had a
rendered-picture tier for heavy pages; it is not in the first cloud release.

## Security

| Boundary | Rule |
|---|---|
| Client and API | A WorkOS access token on every request, for a session the sign-in exchange let in. Clients never hold a GitHub, Claude or Vercel credential. |
| Person and canvas | GitHub decides, checked by the API on every request. |
| Sandbox and API | A token bound to one canvas. The API validates and sanitizes everything it sends. |
| A canvas's HTML and the app | Sanitized on the way in, written out so that no text or attribute can be read as markup whatever the tree holds, drawn in a shadow root, under a strict content security policy: script only from the studio, and nothing reached but the API, Realtime and the canvas's files. Images may load from any https host, in the app as in the runner's previews: they run no script, and what they cost is that an image's host learns the canvas was opened. The preload bridge exposes the minimum. |
| Workspace and workspace | Every row belongs to one workspace. A canvas carries its workspace, and must agree with its repo's; the rows under a canvas (ops, thread, questions, presence and the rest) carry the canvas and reach the workspace through it, so there is no second copy to disagree. Live queries are written by the API, and one scoped to a workspace joins through `canvases`. |

Stored secrets (Claude credentials, GitHub user tokens, repo secrets) are encrypted
with a key that exists only in the API's environment. Each is bound to the row and
column it is stored in, so a value copied anywhere else does not decrypt, and each
names the key that encrypted it, so the key can be rotated.

**Prompt injection.** The agent runs as `agent` with permissions bypassed, beside the owner's
Claude credential (in Claude Code's environment, and in `/proc` for anything running as
`agent`) and the repo's secrets. Anyone whose words reach the model can try to talk it into a
command: a person commenting on the canvas, anyone reviewing its pull request (on a public
repository, anyone on GitHub), a check's log, the repo's own files. Such a command can read and
send the Claude credential and the repo's secrets, and get a one-hour token for the repo from
the runner's socket. It cannot read the runner token, which only the runner's process holds.
What limits it today: other people's words reach the model quoted, under instructions
that quoted text is feedback and never asks for credentials or for anything to be sent
elsewhere; the runner token is good for one canvas and can write nothing an agent could not
(a runner cannot write the API's notices, such as a pull request's); a git token is good for an
hour and one repository. What the agent can do to its pull request is held in the API, not the
prompt: a merge, ready or auto-merge only in a turn a person in Ponzu began, with nothing from
GitHub or anyone else since, as that person, never past the repo's rules ("The agent's pull
request"). A stolen runner token is more than before: taking the lease, it can open, ready,
turn on auto-merge and merge, within the repo's rules and the hourly limits, as a person whose
message the new runner is then handed, with each of those said in the thread. Not with an old
event: only one handed to the runner holding the lease counts. Scrubbing the credential from what the agent's tools inherit
(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`) is not used: in Claude Code 2.1.322 it turns
`bypassPermissions` back to `default` unless every tool is listed in `allowedTools`, and
anything running as `agent` reads Claude Code's environment from `/proc` anyway. What closes
this is in Hardening: the Claude credential behind an egress proxy, so nothing in the sandbox
holds it, and egress rules for `agent`. The list of what remains is in
`apps/runner/image/README.md` ("Users").

Every route says who may call it (anyone, a signed-in person, a canvas's
runner, or either of those two), and a route that does not is refused. A whole
area can be declared for people or for runners; opening a route to anyone is
said on that route and nowhere else. Errors leave the API as
`{ error: { code, message, details? } }` with a stable code and nothing of the
failure itself; logs carry ids and outcomes, never tokens, bodies or headers.

**Rate limits per caller.** Each declaration that authenticates also counts the request against
one rate limit, keyed by the person or by the runner's canvas (`apps/api/src/http/rate-limits.ts`):
creating a canvas, sending messages and answers, upload addresses, `POST /v1/live`, GitHub sync,
and a runner's git credentials each have their own, and every other write by a person, and every
other call by a runner, counts against a catch-all. A read by a person is not counted; the
firewall's per-address rules cover reads and the public routes. Over the limit is 429
`rate_limited` with `Retry-After: 60`. The check is Vercel's firewall, through `@vercel/firewall`
behind `deps.rateLimit`; it runs only when `PONZU_RATE_LIMITS=vercel` on Vercel, and is off
everywhere today, until its rules are applied. Each id's window and limit are a rule in
`infra/vercel-firewall.json` (docs/production.md, "The WAF"), and a test pairs the rules with the
ids the code names, both ways, and with their numbers. It fails open: a check that takes more than
500 ms, fails, or finds no rule lets the request through, logged as `rate_limit_unavailable`. The
count is taken as the caller is authenticated (`auth/access.ts`), once per request, so the
steer gate's `rateLimit` (`http/gates.ts`) stays a pass-through and a steer is never counted twice.

**The maintenance switch.** `PONZU_MAINTENANCE` pauses Ponzu for an incident, for spend, or on
cutover day (`apps/api/src/http/maintenance.ts`). Changing it is a change of the deployment's
environment, so it holds from the next deploy.

- `off`, the default: nothing is held back.
- `wakes_paused`: no sandbox wakes. The wake gate `maintenance` sets the canvas's
  `agent_blocker` to `paused` and tries the wake again every two minutes, so a message is kept
  in the feed and goes in once the switch is off. A turn already running finishes, and a
  sandbox already awake is not held: it takes up what is sent until it goes to sleep, so the
  switch stops new spend only as awake sandboxes sleep. Every minute
  the cron's `maintenance` step, once the switch is off, lifts `paused` everywhere and wakes the
  canvases that owe a turn (`resumeBlocked`), which takes up a wake that ran out of tries during
  a long pause. Everything else works.
- `read_only`: wakes are paused as above, and every write by a person or a runner answers 503
  `maintenance`, "Ponzu is updating. Try again in a few minutes.", before anything of its route
  runs. Reads pass, and so do health, the cron, signing in and out, `POST /v1/live`, a
  person's presence, GitHub's webhook, and a runner's start, heartbeat, checkpoints and their
  uploads, restore and git credentials, so that an awake sandbox is neither taken for dead nor
  loses its work. A runner sends the rest again for as long as it lives, as it does any 5xx.
  The refusal is logged as a refusal, not sent to error tracking. Pause wakes first and let
  running turns finish before going read-only.

The Mac shows the notice "Ponzu is updating. Your canvases are safe; you can look around, and
changes come back in a few minutes." when a write is refused this way, at most once a minute,
and the thread's foot of a paused canvas says "The agent is paused while Ponzu updates. Your
message is kept and goes through when it's back."

## Analytics

PostHog, one project per environment ("Ponzu Dev" for dev, "Ponzu" for production), switched on
by setting `PONZU_POSTHOG_KEY` and off without it. The API captures what happens on the server
(`apps/api/src/analytics/`), sends unexpected errors to error tracking, and traces the model
calls it makes; each canvas's runner traces the agent's turns in LLM analytics; the apps capture
what only they know and record sessions. The rules both sides keep, the event catalogue and what
is never sent are in [analytics.md](analytics.md).

**Share usage data.** Settings › Account has the person's switch, on by default and kept on their
row (`users.share_usage`), so it holds on every device. `PATCH /v1/me/privacy` `{ shareUsage }`
answers `{ shareUsage }` and captures nothing; `GET /v1/me` carries it as `privacy.shareUsage` and
the `me` live row as `share_usage`. Off, the API's sink drops every capture, profile and
exception about the person (who is out is read in the background send and kept a minute per
instance), each event a runner claims says `trace: false`, so the runner sends no `$ai_*` for a
turn that event begins, and the Mac stops its own reporting and writes `~/.ponzu/telemetry.json`.
A turn already running keeps the flag it began with. analytics.md, "Turning it off", has the
details and what is not built.

## Environments

| | Vercel | API | Database | Auth | GitHub App |
|---|---|---|---|---|---|
| Development, the head of `main` | `ponzu-api`, custom environment `dev` | `api-dev.ponzu.design` | Neon branch `dev` | WorkOS staging | `ponzu-dev` |
| Production, live since 12 Nov 2026 | `ponzu-api`, Production target | `api.ponzu.design` | Neon default branch | WorkOS production | `ponzu-cloud` |

There is one Vercel project, `ponzu-api`, with two environments. Production is its Production
target at `api.ponzu.design`; dev is its one custom environment, `dev`, at
`api-dev.ponzu.design`; the Preview target is for throwaway builds on dev's database and never
runs the minute. Vercel keeps a separate copy of the minute's schedule for production and for
each custom environment, so dev runs its own sandbox sweep and job retries without a project of
its own (production's minute still also runs on the legacy cron while the schedule takes over;
production.md, "The minute"). What keeps the environments apart is a set of settings and checks,
not a second project: no variable entry covers Production and another environment, a
deployment whose `PONZU_ENVIRONMENT` disagrees with its Vercel environment never starts (below),
the sandbox module refuses names outside its own scope ("The sandbox"), and each environment
deploys with its own token. What is weaker than two projects (Vercel Sandbox accepts every
environment's OIDC token for the project alike, one firewall config, a spend pause that stops
only production) is written down in
[production.md](production.md), "One project, two environments". The values each environment
uses (its addresses, client ids, buckets and analytics project) are public and live in
[`infra/environments.json`](../infra/environments.json), which names each environment's Vercel
project and Vercel environment. The desktop app bakes one of them in when it is built: a
release the one the file's `release` names, production since the cutover, and Ponzu Dev
always dev's. A field the app reads that is still `null` fails the build, and the release
workflow refuses to publish unless `release` is production with every field set. The
resources, the founder's steps that create production, rotation, backups and spend are in
[production.md](production.md).

The API is deployed by a workflow, which applies the pending migrations to the database first;
nobody deploys a branch to production. Both environments deploy from `main`. Dev deploys with
`vercel deploy --environment dev`, never `--prod`, by `deploy-api.yml`'s dev job once the
repository variable `API_DEPLOY` is set. Production deploys through the GitHub Environment
`production`: the workflow's production job, off until the repository variable
`API_DEPLOY_PRODUCTION` is set and run only after dev's has passed for the same commit, which
builds the deployment without the domain, checks it, and only then promotes it to
`api.ponzu.design`, promoting the one before it back if a check after fails. `vercel promote`, `vercel rollback` and
`vercel alias set` belong to that job and the production runbook alone; dev is taken back by
deploying an older commit to `dev`. Until the variables are set, the orchestrator runs the same
steps by hand from `main` (apps/api/README.md, "Deploying"). Every deployment holds its environment's secrets, so only
the two API domains are public: previews and the unique URL of each deployment open only for
the team. The project's Vercel Authentication would cover `api-dev.ponzu.design` too, so that
one domain is public through a Deployment Protection Exception.

The sandbox image is built once, into the project's one registry, and production pulls the
digest dev checked, so production runs exactly the bytes dev checked. Sandboxes sit beside the
API's functions and the image's registry in the one project, kept apart by their names' scope
("The sandbox"): a deployment can read, run in, stop or remove only the names its own scope
begins, and the sandbox module refuses any other with `out_of_scope`. Vercel does not keep one
environment's functions out of another's sandboxes in the same project, so this check in our
code is the wall.

Every deployment says which environment it is and where its runners call back:
`PONZU_ENVIRONMENT` (`production`, `dev`, `preview` or `local`) and `PONZU_API_URL`. On Vercel
both are required, and a deployment missing either stops at boot with an error that names it,
so no deployment falls back to production's address; one that says `local` stops too. It
also stops when `PONZU_ENVIRONMENT` disagrees with `VERCEL_TARGET_ENV`, the Vercel environment it
runs in (`production` only on the Production target, `preview` on Preview, `dev` on the `dev`
environment); an unset name is logged and allowed; each boot logs both. Off Vercel they
default to `local` and dev's `https://api-dev.ponzu.design`. `GET /v1/health`, public and
given three seconds, reports what is deployed and where: `status`, `version`, `commit`, `environment`, `image` (the runner image,
`ponzu-runner@sha256:…`), `runnerBundle` (the first 12 hex of the runner bundle's SHA-256),
`migrations: { applied, expected }`, `database` and `cron: { lastRanAt }` (when the minute last
ran on this database, null if never; it never changes `status`). `expected` is the journal's entry count,
built in; `applied` is the count of drizzle's record of applied migrations, the number the
migrator compares. The answer is `degraded` at 200 when the two differ, and 503 only when the
database cannot be reached. `apps/api/src/env.ts` exports the names a deployment must set
(`REQUIRED_ENV`), may set (`OPTIONAL_ENV`) and must never set (`FORBIDDEN_ENV`), which the
production check compares with each environment.

A feature that waits on a vendor's key or on the founder's say-so has a switch, read once from
the environment (`apps/api/src/features.ts`) and off when unset: `PONZU_BILLING` (`off`,
`observe` or `on`), push (on when `EXPO_ACCESS_TOKEN` is set), email (on when `RESEND_API_KEY`
is set), `PONZU_REPO_BASES=1`, `PONZU_MERGE_QUEUE=1`, `PONZU_RATE_LIMITS` (`off` or `vercel`)
and `PONZU_MAINTENANCE` (`off`, `wakes_paused` or `read_only`). `GET /v1/me` reports billing,
push and email, so an app shows only what can work.

Each deployment checks its own dependencies and settings: `GET /v1/cron/selfcheck`, behind
`CRON_SECRET` like the minute's cron, and a cron step at minute 7 of every hour
(`apps/api/src/ops/selfcheck.ts`). It answers `{ checks: [{ id, ok, detail }] }` for the
database, the migrations applied against the ones the build has, Realtime sealing, both buckets
(a HEAD of a key that is never stored), WorkOS's key, the GitHub App (its slug, and the
permissions and events the API uses), the App's webhook (its URL is `PONZU_API_URL` plus
`/v1/github/webhook`, json, TLS checked), Ponzu's Anthropic key, the sandbox list, values still
sealed under an old vault key, whether PostHog is set, and whether the minute ran on this
database in the last five minutes (`cron_fresh`: `stale` after that, `never_ran` before its
first run, both failures). Each check has five seconds, and
all run at once. `detail` is a word from a fixed list and never quotes what a service said or
a value from the environment. Two checks add a field: `github_app` names in `missing` the
permissions or events from the API's own list that the App lacks, and `vault_old_keys` gives
its `count`. The hourly step raises each failed check to PostHog as an
exception (`selfcheck_failed`, with `check`), which is the alarm; the old-keys count and
PostHog are informational and only logged.

### Checking a deploy's sandboxes

After a deploy that changes the sandbox lifecycle, the image or the runner, on the deployed API:

1. Message an existing Scratch canvas and an existing repo canvas. Each logs `sandbox_awake`,
   and a canvas whose disk was empty logs `sandbox_rebuilt`; the repo canvas restores from its
   checkpoint and checks out its branch.
2. After the idle sleep, a second message wakes it with `sandbox woke` `start: "resume"` and
   `fresh: false`.
3. The Vercel dashboard's sandboxes for ponzu-api show only `pz-<scope>-` names (and
   `pz-test-` ones a live run is using), and none of this deployment's is running five minutes
   after the last activity.
4. No `sandbox_leak` in the logs.
5. The command log of a `ponzu-start` holds only that script's own lines (none of the runner's,
   and no secret).
6. `sandbox woke` `duration_ms` runs from the wake job's start to `ponzu-start` being accepted
   (not to the runner answering): 1.0 to 1.6 seconds for a create or a resume and 0.4 seconds
   for a restart in place were measured from a local API on real sandboxes. A resume's runner
   answers `/health` about a second after that (1.8 to 2.9 seconds from the message in the
   spike).
7. Nothing at Vercel holds `VERCEL_TOKEN` for Preview, `dev` or Production: the API refuses it
   there and runs on OIDC.
8. With a person's session against the deployed API, run the client's live suites:
   `packages/client/src/lifecycle.live.test.ts` (it prints `wake to answer`, the time from a
   message to the runner's first answer, the number the speed claim rests on) and
   `packages/client/src/image-move.live.test.ts`.
9. With the setup in "Setting up the image workflows" done, dispatch the Image workflow
   (`image.yml`) once: it builds, pushes to the registry through the OIDC policy, checks the
   image in a sandbox, opens a pull request with `current.json` and dispatches CI on it.

Tests run against an in-process Postgres (PGlite), so they need no network. PGlite
is a single connection, so CI also runs the database's races, and each kind of
statement once, on a Postgres 18 beside the job. Migrations are generated by
drizzle-kit and applied in CI, over one connection and in one transaction. They only add, so
an older API runs on a newer schema, with one exception: `0025_canvases` renames the tables
and columns to their canvas names, so no deploy from before it may be rolled back to across it
([production.md](production.md), "Backups and restore").

## How this lands

Work happens on the `cloud` branch through pull requests into it. `main` is left
alone until cutover, so the 1.x app, the site and the phone keep shipping exactly
what they ship today and nothing has to be paused. Cutover is one pull request
from `cloud` into `main`, released as the next major version.

1. **Foundation.** Core (validation, sanitizing, the replica), the database, the
   sandbox module, the API, the client package.
2. **The loop.** The runner, the sandbox lifecycle, the thread, events, GitHub.
   Ends with a canvas made by Claude in a sandbox, shown live in a client.
3. **The apps.** Desktop shell, studio, mobile.
4. **Billing.**
5. **Cutover.** Delete the local runtime, rewrite the docs and the site, release.
6. **Hardening.** Egress proxy for credentials, egress rules for the agent's user, a runner
   user without sudo, limits, observability, abuse controls, the picture tier. (Claude Code's
   tools as a user apart from the runner's is done: the image's `agent`.)

## Known constraints

- **Times, measured on Vercel from the image** (the spike, 2026-11-11, from a Mac): a create
  answers its first command in about 1 second and shows the first artboard 6 to 7 seconds after
  the message; a wake from the snapshot answers `/health` in 1.8 to 3 seconds and shows the first
  artboard 4 to 6.5 seconds after the message. Every wake boots a new VM from the snapshot, so
  memory never survives a sleep. The thread shows a waking state.
- **Secrets in a command's env.** The runner's environment goes in the one `ponzu-start`
  command's env. Vercel's command record has no env field, and the runner's output goes to a
  file, not to Vercel's command log; whether Vercel stores a command's request body, and what its
  command logs keep, is not documented, and has been asked in writing. If it does, the Claude
  credential and the repo's secrets move into the runner's session answer.
- **OIDC lives in a request.** A sandbox call made outside a request or the work it keeps (at
  module load, from a stray timer) fails with Vercel's OIDC context error, and so would every
  wake. The rule is in "The sandbox"; a preview deploy that wakes a canvas proves it.
- **A sleep cut off.** If the API dies between moving a row to `stopping` and stopping the
  session, the VM runs until its session timeout (30 minutes at most) or until the sweep's repair
  or reconcile stops it.
- **A new image recreates every canvas at its next wake** and loses its gitignored files. If
  Claude Code bumps prove frequent, Claude Code can move into the runner bundle too
  (`bundle-fits` already checks its version).
- **Not yet seen on Vercel:** a host lost under a running sandbox, a resume after days idle,
  creates racing on one name in production, failover regions, and a detached command running
  for many hours. The checkpoint marker handles a disk that comes back old or empty.
- **Vercel is the only vendor** for the API, the cron, the sandboxes and the image registry,
  with no fallback, by choice. `@vercel/sandbox` is pinned exactly; before a bump, the live suite
  (`PONZU_LIVE_VERCEL=1 bun test packages/sandbox/src/vercel.live.test.ts`) and
  `surface.test.ts` run again, since a newer SDK may create through another API version with
  other snapshot defaults, and resume on more calls.
- **What can still be lost, at worst,** now that the disk is a cache in fact (principle 2):
  - what a turn did after its last checkpoint, when the sandbox's disk is lost before the next
    (a turn's end and every sleep save one, so this is a turn cut off by a crash or a host lost
    while it ran);
  - files never in a checkpoint: ignored by the repo (`dist/`, `node_modules`, a `.env.local`),
    over 5 MB or past 50 MB in all, or holding a secret (above); the secrets come back with the
    environment, built files with a build;
  - the conversation after it outgrew 64 MB compressed: the files keep being saved, the
    transcript stored is the last that fit, and the thread said so;
  - uncommitted work that cannot go back on a pushed branch that moved on: it is on
    `ponzu-wip/turn-<n>` in the sandbox, and the thread says so, but nothing merges it;
  - a turn's usage counted twice after a disk came back old, since the usage totals are not in
    the checkpoint.
- A runner that is answered 409 `superseded` while it starts exits 78 and stays down until the
  dead-runner sweep (90 seconds unheard) puts the sandbox to sleep and wakes it on a new
  environment. A session call retried after a lost answer, with the first landing after the
  retry, would do it; a session call that names the starting process would close that.
- A recreate onto a new image goes by whether the last checkpoint holds every event delivered
  into the session, and the API counts as held what had been delivered when the checkpoint was
  recorded. An event the runner took into a new turn while it was still uploading the checkpoint
  of the last is counted as held though it is not. The turn's own checkpoint, or the one the sleep
  saves, records it soon after; only when both of those fail and the canvas is recreated before
  another is saved is that turn missing from the conversation after it (the thread still has it).
  The runner naming, with each checkpoint, the newest event it holds would close it.
- Until `R2_PRIVATE_BUCKET` is set, checkpoint archives sit in the assets bucket under a random
  key (above). Work in progress pushed to `refs/ponzu/wip/<canvas>` by the first version of this
  (dev only) stays on those repositories until someone deletes the refs.
- A sleep takes a few seconds (`ponzu-stop`, then the snapshot: `putToSleep` took 1.3 seconds
  with a 549 MiB snapshot from a local API on a real sandbox; a runner mid-turn takes longer, up
  to `ponzu-stop`'s 30 seconds). A message that arrives meanwhile finds the row `stopping` and its wake waits for the
  sleep to land, up to 30 seconds, then resumes.
- **The minute runs on Vercel Schedules, which are in beta**
  ([Schedules](https://vercel.com/docs/schedules): "Behavior, APIs, and limits may change before
  general availability"). It is the static schedule `minute` in `apps/api/vercel.json`, one copy
  in production and one in the `dev` environment, each turned on there (production keeps the
  legacy cron beside it until its schedule has fired, so it never lacks a run; production.md,
  "The minute"). Every run starts at some
  point in the minute after its time (Pro's one-minute jitter), so the route takes the
  scheduler's own time for the run when it is within two minutes of the clock. A run that fails
  or times out is not retried. A run Vercel could not deliver on time is delivered late, and
  after an outage up to a dozen missed minutes (those of the last 11) arrive at once; duplicates are
  possible but rare ([Concepts](https://vercel.com/docs/schedules/concepts)). The steps already
  take only what nobody holds and record each slot once, so overlap, lateness and repeats are
  safe. What is not safe is a scheduler that stops: each run records its time, `/v1/health`
  answers it as `cron.lastRanAt`, the selfcheck's `cron_fresh` fails five minutes after it, and
  production's uptime check counts a stale minute as down.
- Neon Realtime is a public beta.
- A commit can be authored by the person or verified, not both. Repos that require
  signed commits on the pushed branch need the API commit path.
- **Search** (above):
  - **Common words are slower than the target.** On Postgres 17 and on Postgres 18.6 (in Docker),
    both on a loaded Mac (`search-bench.ts`), at 100,000 entries in one workspace, rare words, one-
    and two-letter prefixes, `#412`, CJK and queries with no hit stay at or under about 9 ms p95,
    but a word found in about a fifth of all entries takes 57 to 95 ms p95, against the 50 ms
    target. On Postgres 17 such a word took 0.6 to 3 seconds at 1,000,000 entries; that size was
    not run on Postgres 18. It has not been measured on Neon. Past 150 ms p95 for
    a day on production, or about 1,000,000 entries in one workspace, the next steps are partial
    indexes per kind, a `(canvas_id, folded)` index with `btree_gin`, and then an outside engine
    fed from `search_entries`.
  - Only the first 8,000 characters of a message, comment or answer are searched.
  - Asides, tool steps and the words of a turn that stopped or failed before it answered are not
    indexed, and neither is an answer of a turn that ended with no `final`.
  - Whether CJK and other non-Latin text yields trigrams depends on the database's ctype. Under
    the C locale it still matches, but by scanning the index whole, so it is slower.
  - An older pull request read can briefly put back an older title, until the next read.
  - People are matched in TypeScript, which is fine to about 2,000 people shown in a workspace.
  - Results follow repo access as the canvas list does: up to a minute behind GitHub (10 while
    GitHub fails). A member who leaves loses search at once.
  - An index write that fails after the runner's thread write, or an answer that arrives after
    its turn's ending, is repaired by the reindex it queues, so an answer can be missing from
    search until the next minute's jobs run.
