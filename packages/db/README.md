# @ponzu/db

The Postgres schema for Ponzu Cloud, its migrations, and the queries the API calls.
The architecture it serves is [docs/cloud.md](../../docs/cloud.md). Production is Neon
(Postgres 18); tests run on PGlite, a Postgres inside the test process.

```sh
bun run db:generate                    # after changing src/schema: write the next migration
DATABASE_URL=… bun run db:migrate      # apply what is pending (a direct URL, not Neon's pooled one)
bun test packages/db
```

A test fails if the schema and the migrations disagree. Never edit a migration that has
been applied; change the schema and generate the next one.

`db:migrate` runs over one connection and applies everything pending in a single
transaction, so a migration that fails leaves the database as it was. It then checks that
every migration in the journal is recorded as applied, and fails if one was passed over
(Drizzle skips a migration that is older than the newest one applied, which is what a
migration written on one branch and merged after another is).

Migrations are expand first, contract later. A deploy migrates before its code goes live, and
Vercel's instant rollback runs older code on the newer schema, so a migration never takes away
what a deployed API reads or writes. `bun scripts/ci/migrations.ts` (a step in CI's "Lint,
typecheck, build") fails on a DROP TABLE, DROP COLUMN, RENAME, ALTER COLUMN … TYPE, SET NOT
NULL, ADD COLUMN … NOT NULL without a DEFAULT, TRUNCATE, or DROP SCHEMA or VIEW, unless the
line right before it is `-- contract: <why nothing deployed uses it any more>`. Contract in a
later pull request than the one that stopped using the thing, after that one is deployed. The
three migrations from before the rule are listed in the script with their reasons and
checksums, so an edit to one of them is linted again. A rename below is a contract too: it
needs its `-- contract:` line, and the old name kept working until no deployed API reads it.

A rename is written by hand. Run `bunx drizzle-kit generate --custom --name <name>`, write the
SQL, and replace the body of the snapshot it wrote (a copy of the one before) with
`generateDrizzleJson(schema, prevId)` from `drizzle-kit/api`, keeping its `id` and `prevId`; a
plain `db:generate` must then find nothing to do. Never answer drizzle-kit's rename prompts:
they drop and re-create keys and indexes. `0025_canvases` is one. It gave canvas names to
every table, column, key and index named for the old word, and refuses to run unless every
sandbox is asleep. `schema/catalog.test.ts` checks that a database migrated from the first
migration names everything exactly as one built fresh from the schema does.

### Tests on a real Postgres

PGlite is one connection. Its races take turns, and its planner never sees a table that was
empty a moment ago, so some bugs cannot show there. The `*.live.test.ts` files run the
statements that race, and every kind of statement once, over real connections. CI runs them
on a Postgres 18 (the "Database on Postgres" job). To run them yourself:

```sh
docker run -d -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ponzu_test -p 5432:5432 postgres:18
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/ponzu_test
bun run db:migrate
PONZU_TEST_DATABASE_URL=$DATABASE_URL bun test packages/db
```

They empty the `jobs` table, so they refuse a database without `test` in its name. Given a
Neon URL they run over both of Neon's drivers.

## Using it

```ts
import { commitOps, createDb } from "@ponzu/db";

const db = createDb(process.env.DATABASE_URL); // Neon over HTTP
const result = await commitOps(db, { canvasId, expectedSeq, actor, ops });
```

- Every query is a function that takes the database first. The API writes no SQL of its own.
- **Every query is one statement.** Neon's HTTP driver has no interactive transactions, so
  a function that must do two things atomically does them in one statement with `WITH`.
  The functions also run inside a transaction on `createPooledDb`, for a handler that needs one.
- A statement that fails throws a `QueryError`. Its message is what Postgres said
  (it names the constraint). Drizzle's own error lists every parameter of the statement,
  which would put op batches and payloads into the logs; this one does not. Its `unavailable`
  is true when Postgres never answered (Neon unreachable, or out of time) rather than refused.
- `createDb(url, { deadline })` asks `deadline` for an `AbortSignal` before each statement,
  which is how the API gives the database ten seconds. Without one a statement can wait as
  long as the runtime's `fetch` does.
- **A query that depends on the time takes `now` from its caller**, as the GitHub token claim,
  presence and a runner's lease and heartbeat do, so a test can move the clock. The older ones
  still read Postgres's `now()` (runner token expiry, job leases; `claimJobs` takes a `now` for
  when a job is due, which its caller then sets `runAt` by); convert one when a module
  comes to depend on its timing, and do not add to them. (An event claim depends on no time: it
  hands an event to each runner once.)
- `@ponzu/db/testing` exports `createTestDb()`: a migrated PGlite database, about 60 ms each,
  and `createEmptyTestDb()`, an empty one. Both load a copy kept in the temporary directory,
  which `bun test` makes before any test starts (`src/test-preload.ts`, preloaded by the root
  `bunfig.toml`), so no test runs initdb or the migrations inside its timeout. A test that
  needs a Postgres takes one of these, never `new PGlite()`.
- `@ponzu/db/types` is for clients: the fixed lists (`AGENT_STATES`, `EVENT_PRIORITIES`, …),
  their types and the canvas head. It imports no driver and no Drizzle. The package root
  does, so a browser or phone bundle must not import a value from it.
- Ids are text with a prefix that says what the row is (`cnv_…`, `usr_…`), made by `newId`.
  Canvases made before the rename keep the ids they were made with, `des_…`: nothing checks
  the prefix, and every link and foreign key holds the id as it is.
- Columns named `encrypted_…` hold ciphertext. The key is the API's; this package never sees it.

## Committing ops

`commitOps` appends a batch to `canvas_ops` and moves `canvases.seq` past it in one statement.
The update of the canvas's row matches only while `seq` is still the caller's `expectedSeq`,
and the insert takes rows only if that update happened. Two callers racing on one seq: the
second waits on the row lock, sees `seq` has moved, writes nothing and gets `{ kind: "conflict" }`.
An op whose id is already in the log is not appended again; the stored op comes back instead.

**How long a retry is safe.** An op's id is remembered for as long as its row is in the log.
`writeCheckpoint` prunes an op only when it is covered by the checkpoint, outside the newest
200 (`UNDO_DEPTH`), and older than seven days (`OP_RETENTION_DAYS`). So posting an id again
within seven days always answers with the original; after that it may be appended as new,
and a sender must drop a pending op that old. `pruneOps` does the same pruning on its own,
for a canvas that stopped changing before its last ops were old enough to go.

**Text Postgres cannot store.** A NUL (U+0000), or half of a surrogate pair, fails any
statement that carries it. For ops and documents, which must be stored exactly or not at
all, `commitOps` answers `{ kind: "unstorable", ids }` and writes nothing; call
`isStorable(op)` while validating, so one such op is rejected and the rest of its batch
goes on. For thread, event and question payloads the characters are replaced with U+FFFD.
A plain text column (a canvas's name, a thread item's id) is not checked here: a NUL in one
is a `QueryError`. `isStorable` takes any json value, so the API can ask it of a request body.

## Search entries

`search_entries` holds what search finds, one row per thing, under its canvas. **An entry is
written by the statement that changes its source**, so the two never disagree:

- a canvas's name, pages, boards and comments by the commit statement (`commitOps` and
  `commitReversal` take `search`, which is `docSearchChanges(before, after, ops)` from
  `@ponzu/core`), and by `createCanvas` for the document it starts as;
- a person's message by `postMessage` (and `createCanvas`'s first message) when given `search`;
- a pull request's title by `recordPullRequestRead`, only when the text differs;
- the agent's settled answers by `upsertSearchEntries`, which the runner's thread write cannot
  carry.

`replaceDocSearchEntries` rebuilds a canvas's document entries whole, at a seq, holding the
canvas's row while it does, and records the version in `search_state`; `queueSearchBackfill`
queues that (`search.reindex` jobs, due at the caller's `now`) for canvases no reindex has
done at the current `SEARCH_VERSION`, with at most `limit` waiting at once. `deleteSearchEntries`
takes out entries by key (a reindex removing an answer its turn no longer names), and
`listSearchEntries` reads a canvas's rows as stored, empty ones included, for tests and checks.

Rules that keep it from ever failing a commit: `toSearchRows` keeps one row per key, makes
every string storable, and drops a ref too long to index; the table has no check constraints;
and a commit whose ops touch nothing searched (`docSearchChanges` answers null) sends no
search SQL at all. A commit removes an entry by emptying it (`text` and `folded` empty) rather
than deleting it: a delete sees the rows as they were when its statement began, so a commit
that waited on a reindex's lock would miss what the reindex had just written, while an upsert
reaches it. An empty entry matches no search, and the canvas's next reindex deletes it.

An entry keeps the name its author had when it was written, so deleting an account
(`anonymiseUser`) renames that person's entries to "Deleted user", as it does their thread
items. A write whose person author names no `users` row stores "Deleted user" too, so a commit
or a reindex never writes back the name a document's comment still carries.

The migration that made the table creates the `pg_trgm` extension, a line written by hand
(drizzle-kit does not emit extensions). PGlite is given it in `createTestDb`. A second
hand-written line, `SET LOCAL lock_timeout = '5s'`, comes first: the two foreign keys take SHARE
ROW EXCLUSIVE on `canvases` until the migration commits, which holds every write to it (about
10 ms on a Postgres 18 with 10,000 canvases). If a long transaction is writing to `canvases`, the
migration gives up after 5 seconds and leaves the database as it was, to be run again, instead
of queueing live writes behind it.

**Reading.** `searchCanvases` answers a search in one statement, from the canvases
`readableCanvases` lets the person read. That condition is the canvas list's too
(`listWorkspaceCanvases`): a member's own Scratch canvases, and the canvases of repos
`repo_access` says they can read, never anything once they are not a member. So search can never
find a canvas the list would not show; `search.access.test.ts` checks it over 200 random access
matrices. Terms reach the statement only as parameters, each checked by core's
`assertSearchTerm`, and matching is on `folded`: a one-word term anywhere, a short one (one or two
characters) only at a word start, a phrase its words in order. Hits rank by tier (the whole
text, its start, every term at a word start, anywhere), then by recency, then by key, at most 8
a group and 4 pull requests. A query of short words alone searches names only, through a second
trigram index over the names (`search_entries_names_trgm_idx`). `scripts/search-bench.ts` times
it on a real Postgres.

## Tables

Clients watch the tables marked **live** through Neon Realtime. That puts these rules on them:

- A watched row is sent whole on every change, and one over 4 MiB ends the subscription. So
  content never lives in one: a canvas's document is in `canvas_ops` and `canvas_checkpoints`,
  and clients watch only `canvases.seq`, then fetch the ops after their own seq from the API.
- Every table has a primary key.
- A live query is a plain filter or join that names its columns, by their own names. Never
  select an `encrypted_…` column in one, or `canvases.asset_key`, and sort on the client.
- Rows below a canvas (`thread_items`, `questions`, `presence`, …) carry `canvas_id`, not a
  workspace. A live query scoped to a workspace joins through `canvases.workspace_id`.
- **Everything in a watched row is plaintext that every watcher receives.** A question's
  answer and a thread item's payload are that, and an event's payload is stored in the clear
  too. A secret never goes in one: `answerSecretQuestion` puts the value in `repo_secrets`
  and records only the secret's name, and the table refuses anything else for a secret.
- Realtime delivers a `bigint` as a string, so two seqs compared raw put "10" before "9".
  For the canvas head, select `CANVAS_HEAD_COLUMNS` and decode each row with `toCanvasHead`.
  The other watched `bigint` columns need the same `Number(…)`: `thread_items.seq`,
  `questions.seq`, `canvas_reads.seen_seq` and `seen_thread_seq`, and the GitHub ids on
  `users`, `workspaces` and `repos`.

People and access

| Table | What it is for | |
|---|---|---|
| `users` | A person: their WorkOS and GitHub identity, agent defaults, ping settings, onboarding steps. The GitHub account is who they are. | live |
| `sessions` | The WorkOS sessions the sign-in exchange let in. A token is honored only for one of these; signing out deletes the row. | |
| `github_user_tokens` | A person's GitHub token, encrypted. Used to ask GitHub what they can reach. `refresh_claimed_until` is the lock that lets one function instance at a time refresh it. | |
| `workspaces` | A GitHub account with the App installed, and its billing: Stripe customer and card, cap, period anchor, the cached billing gate, the next close, past due. Keyed by the account; the installation id changes on a reinstall. `reconciled_at` is when the installation was last read as the App. | live |
| `uninstalled_installations` | Installation ids GitHub said are gone. GitHub never reuses one, so a read that began before the uninstall cannot bring it back. | |
| `memberships` | Who can reach a workspace, as GitHub last said, how (`github_access`: owner, member of its organization, or collaborator on some repos), and their role (admin or member). An owner is always an admin. | live |
| `repos` | A repo the App can see: default branch, the base snapshot new canvases start from, its stack, ideas. | live |
| `repo_access` | What GitHub last said each person may do in each repo (`admin`, `write`, `read`, `none`), and when: the one answer to who may see or steer a repo. A person's sync writes a whole workspace of them (`recordReachableRepos`), a question asked as the App writes one (`recordRepoAccess`), and a webhook that cannot say whose access changed makes them stale (`markRepoAccessStale`). The repo list, the canvases list and the live queries join it, so a repo and its canvases show only to people who can read it. A row is replaced only by a newer answer, and is read only alongside the person's membership. | live |
| `repo_secrets` | A repo's environment variables, encrypted. | |
| `claude_accounts` | A person's own Claude: subscription or API key (encrypted, destroyed on disconnect while the row stays `revoked`), status, expiry, last known limits. | live |
| `devices` | A phone or Mac to push to. | |
| `auth_states` | Short-lived: a GitHub install in progress, a Claude sign-in waiting for its code, or a card being added on Stripe's Checkout page (`card_setup`). A person has one Claude sign-in open at a time and starts so many an hour (`openClaudeSignIn`); a workspace has one card setup open at a time (`beginCardSetup`), settled once (`settleCardSetup`). | |

Canvases

| Table | What it is for | |
|---|---|---|
| `canvases` | One canvas: workspace, repo (null for Scratch), owner, branch, status, `seq`, pull request and agent state. Small on purpose. | live |
| `canvas_ops` | The ordered log of a canvas. Each op with its inverse, who made it, and whether it was undone. `json`, not `jsonb`. | |
| `canvas_checkpoints` | The whole document as of a seq. The current document is the latest one plus the ops after it. | |
| `canvas_reads` | How far each person has looked at each canvas, for the unseen dot. | live |
| `presence` | Who has a canvas open. A row per person per canvas, refreshed every 30 seconds, stale after 75. | live |
| `assets` | A file a canvas uses. The bytes are in R2. | |
| `uploads` | Bytes on their way to R2: what a signed address was made for (purpose, name, type, size, SHA-256), until the uploader completes it and the file is recorded where it belongs. | |
| `search_entries` | One searchable thing on a canvas, keyed by canvas, kind and ref: its name, a page's or board's name, a comment thread's message, a thread message (a person's, or the agent's settled answer), a pull request's title. The text as shown and `folded`, what is matched, under a pg_trgm GIN index, and the names under a second, partial one. No workspace column and no check constraints. See "Search entries". | |
| `search_state` | Which version of the search rules last indexed each canvas whole, and at which seq. Apart from `canvases` so writing it reaches no watcher. | |

The agent

| Table | What it is for | |
|---|---|---|
| `thread_items` | The agent thread: messages, comments, the agent's text (updated in place while it streams), tool steps. Keyed by canvas and id: the runner chooses its items' ids, and the same id in another canvas is another row. | live |
| `events` | Things that happened to a canvas, with a priority, waiting for its runner to take them. A person's ops append theirs in the statement that commits them (`commitOps`'s `events`), with a comment's thread item beside its event. `claimed_by` is the runner each was last handed to: an event goes to each runner once. `claim_id` is the runner's id for the claim that did, so a claim sent again hands out the same events. | |
| `questions` | Needs-you: a question, permission, plan or secret the agent is waiting on, and its answer. Keyed by canvas and the id the runner chose. Answering one adds its `answer` event in the same statement. | live |
| `sandboxes` | A canvas's Vercel sandbox, one row per canvas, keyed by `canvas_id` (no row is no sandbox): its state (`asleep`, `waking`, `awake`, `stopping`) and when it got there, the session every call is pinned to and when it started, its port's address and sealed bearer, its deadline, the image it runs, the runner token and Claude credential its runner was started with, its awake-since and who it is put down to. Every move holds to the state it moves from and to the job holding a `waking` or `stopping` row (`waking_by`; `retire:<job>` while a retire holds it), and leaving `awake` meters the stretch under `canvas_id/epoch_ms(awake_since)` (`moveSandbox`). A wake claims it first (`beginSandbox`, `claimSandbox`), counted against the sandboxes up in its workspace and for its owner. | |
| `canvas_runners` | A canvas's runner now: the lease (`runner_id`) the API takes calls from, what the runner said it is as it took it (`client`, with its image), when it was last heard from, and the Claude session to resume. Its last checkpoint, with `saved_through`: the newest event delivered when it was recorded, which says whether the checkpoint holds the session (`getCheckpointCover`). Apart from `canvases` so the heartbeat does not touch a watched row. | |
| `runner_tokens` | What a runner signs in with, hashed. Good for one canvas until it expires. | |

Money

| Table | What it is for | |
|---|---|---|
| `rate_cards` | The numbers of the credit model, by version. A price change is a new row. | |
| `usage_events` | One metered thing: a stretch of awake sandbox time (or a piece of one, cut at a period end or hourly while billing is on, `cutAwake`), or one model turn and its tokens. The one record of use. | |
| `credit_ledger` | What changes a workspace's free credits other than use: grants, adjustments (`adjustCredits`), later top-ups and refunds. No `use` row is written; use is `usage_events`. | |
| `billing_periods` | One closed billing period of a workspace: its numbers frozen once (`beginPeriodClose`), its status, and its one Stripe invoice, stored as soon as Stripe makes it (`setPeriodInvoice`). Written only while billing is observe or on. | |

Plumbing

| Table | What it is for | |
|---|---|---|
| `jobs` | Work that must finish even if the request that started it does not. The cron takes what is left, and closes what ran out of attempts. | |
| `webhook_deliveries` | Webhooks already taken, so a redelivery is not processed twice. | |

## Workspaces, repos and canvases

A canvas names its workspace and, unless it is Scratch, its repo. The two cannot disagree:
the foreign key is the repo and its workspace together. When GitHub transfers a repo to
another account, `upsertRepos` moves the repo and its canvases follow in the same statement.
Usage already recorded stays with the workspace that was billed for it.

A canvas's pull request is recorded from reads of GitHub by `recordPullRequestRead`, which keeps
the read that began last (`canvases.pr_read_at`, since a check finishing leaves GitHub's
`updated_at` alone and reads finish out of order), and settles the canvas on a merge. A merge
is the last word on its pull request: nothing about it is recorded after one, so a canvas
reopened after its merge stays open. A read that finds what the row already holds writes
nothing, since each write reaches every watcher of the workspace's canvases. For the same reason
the pull request's thread notice goes in with `appendThreadItemOnce`, which never rewrites an
item it already has.

## Deleting

Deleting a canvas deletes everything that is only its own (ops, checkpoints, thread, events,
questions, sandboxes, tokens, assets). Its usage stays, for the bill. Deleting a person
leaves their canvases to the workspace. A workspace or repo cannot be deleted while it has
canvases, and a workspace cannot be deleted while it has usage or ledger entries.
