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
const result = await commitOps(db, { designId, expectedSeq, actor, ops });
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
- **A query that depends on the time takes `now` from its caller**, as the GitHub token claim
  does, so a test can move the clock. The older ones still read Postgres's `now()` (runner
  token expiry, job leases and retries, presence, event claims); convert one when a module
  comes to depend on its timing, and do not add to them.
- `@ponzu/db/testing` exports `createTestDb()`: a migrated PGlite database, about 60 ms each.
- `@ponzu/db/types` is for clients: the fixed lists (`AGENT_STATES`, `EVENT_PRIORITIES`, …),
  their types and the design head. It imports no driver and no Drizzle. The package root
  does, so a browser or phone bundle must not import a value from it.
- Ids are text with a prefix that says what the row is (`des_…`, `usr_…`), made by `newId`.
- Columns named `encrypted_…` hold ciphertext. The key is the API's; this package never sees it.

## Committing ops

`commitOps` appends a batch to `design_ops` and moves `designs.seq` past it in one statement.
The update of the design's row matches only while `seq` is still the caller's `expectedSeq`,
and the insert takes rows only if that update happened. Two callers racing on one seq: the
second waits on the row lock, sees `seq` has moved, writes nothing and gets `{ kind: "conflict" }`.
An op whose id is already in the log is not appended again; the stored op comes back instead.

**How long a retry is safe.** An op's id is remembered for as long as its row is in the log.
`writeCheckpoint` prunes an op only when it is covered by the checkpoint, outside the newest
200 (`UNDO_DEPTH`), and older than seven days (`OP_RETENTION_DAYS`). So posting an id again
within seven days always answers with the original; after that it may be appended as new,
and a sender must drop a pending op that old. `pruneOps` does the same pruning on its own,
for a design that stopped changing before its last ops were old enough to go.

**Text Postgres cannot store.** A NUL (U+0000), or half of a surrogate pair, fails any
statement that carries it. For ops and documents, which must be stored exactly or not at
all, `commitOps` answers `{ kind: "unstorable", ids }` and writes nothing; call
`isStorable(op)` while validating, so one such op is rejected and the rest of its batch
goes on. For thread, event and question payloads the characters are replaced with U+FFFD.
A plain text column (a design's name, a thread item's id) is not checked here: a NUL in one
is a `QueryError`. `isStorable` takes any json value, so the API can ask it of a request body.

## Tables

Clients watch the tables marked **live** through Neon Realtime. That puts these rules on them:

- A watched row is sent whole on every change, and one over 4 MiB ends the subscription. So
  content never lives in one: a design's document is in `design_ops` and `design_checkpoints`,
  and clients watch only `designs.seq`, then fetch the ops after their own seq from the API.
- Every table has a primary key.
- A live query is a plain filter or join that names its columns, by their own names. Never
  select an `encrypted_…` column in one, or `designs.asset_key`, and sort on the client.
- Rows below a design (`thread_items`, `questions`, `presence`, …) carry `design_id`, not a
  workspace. A live query scoped to a workspace joins through `designs.workspace_id`.
- **Everything in a watched row is plaintext that every watcher receives.** A question's
  answer and a thread item's payload are that, and an event's payload is stored in the clear
  too. A secret never goes in one: `answerSecretQuestion` puts the value in `repo_secrets`
  and records only the secret's name, and the table refuses anything else for a secret.
- Realtime delivers a `bigint` as a string, so two seqs compared raw put "10" before "9".
  For the design head, select `DESIGN_HEAD_COLUMNS` and decode each row with `toDesignHead`.
  The other watched `bigint` columns need the same `Number(…)`: `thread_items.seq`,
  `questions.seq`, `design_reads.seen_seq` and `seen_thread_seq`, and the GitHub ids on
  `users`, `workspaces` and `repos`.

People and access

| Table | What it is for | |
|---|---|---|
| `users` | A person: their WorkOS and GitHub identity, agent defaults, ping settings, onboarding steps. The GitHub account is who they are. | live |
| `sessions` | The WorkOS sessions the sign-in exchange let in. A token is honored only for one of these; signing out deletes the row. | |
| `github_user_tokens` | A person's GitHub token, encrypted. Used to ask GitHub what they can reach. `refresh_claimed_until` is the lock that lets one function instance at a time refresh it. | |
| `workspaces` | A GitHub account with the App installed, and its billing: Stripe customer, cap, period anchor. Keyed by the account; the installation id changes on a reinstall. | live |
| `memberships` | Who can reach a workspace, as GitHub last said, and their role (admin or member). | live |
| `repos` | A repo the App can see: default branch, the base snapshot new designs start from, its stack, ideas. | live |
| `repo_secrets` | A repo's environment variables, encrypted. | |
| `claude_accounts` | A person's own Claude: subscription or API key (encrypted), status, expiry, last known limits. | live |
| `devices` | A phone or Mac to push to. | |
| `auth_states` | Short-lived: a GitHub install in progress, or a Claude sign-in waiting for its code. | |

Designs

| Table | What it is for | |
|---|---|---|
| `designs` | One design: workspace, repo (null for Scratch), owner, branch, status, `seq`, pull request and agent state. Small on purpose. | live |
| `design_ops` | The ordered log of a design. Each op with its inverse, who made it, and whether it was undone. `json`, not `jsonb`. | |
| `design_checkpoints` | The whole document as of a seq. The current document is the latest one plus the ops after it. | |
| `design_reads` | How far each person has looked at each design, for the unseen dot. | live |
| `presence` | Who has a design open. A row per person per design, refreshed every 30 seconds, stale after 75. | live |
| `assets` | A file a design uses. The bytes are in R2. | |

The agent

| Table | What it is for | |
|---|---|---|
| `thread_items` | The agent thread: messages, comments, the agent's text (updated in place while it streams), tool steps. | live |
| `events` | Things that happened to a design, with a priority, waiting for its runner to take them. | |
| `questions` | Needs-you: a question, permission, plan or secret the agent is waiting on, and its answer. | live |
| `sandboxes` | A design's sandbox at the provider: state, address, awake-since, the Claude session to resume. | |
| `runner_tokens` | What a runner signs in with, hashed. Good for one design until it expires. | |

Money

| Table | What it is for | |
|---|---|---|
| `rate_cards` | The numbers of the credit model, by version. A price change is a new row. | |
| `usage_events` | One metered thing: a stretch of awake sandbox time, or one model turn and its tokens. | |
| `credit_ledger` | Every change to a workspace's credits: grants, use, top-ups, refunds. The balance is the sum. | |

Plumbing

| Table | What it is for | |
|---|---|---|
| `jobs` | Work that must finish even if the request that started it does not. The cron takes what is left, and closes what ran out of attempts. | |
| `webhook_deliveries` | Webhooks already taken, so a redelivery is not processed twice. | |

## Workspaces, repos and designs

A design names its workspace and, unless it is Scratch, its repo. The two cannot disagree:
the foreign key is the repo and its workspace together. When GitHub transfers a repo to
another account, `upsertRepos` moves the repo and its designs follow in the same statement.
Usage already recorded stays with the workspace that was billed for it.

A design's pull request is recorded from GitHub's webhooks by `recordPullRequest`, which keeps
the newest word (`designs.pr_updated_at`, GitHub's `updated_at`) since deliveries arrive out
of order, and settles the design on a merge.

## Deleting

Deleting a design deletes everything that is only its own (ops, checkpoints, thread, events,
questions, sandboxes, tokens, assets). Its usage stays, for the bill. Deleting a person
leaves their designs to the workspace. A workspace or repo cannot be deleted while it has
designs, and a workspace cannot be deleted while it has usage or ledger entries.
