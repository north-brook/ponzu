# @ponzu/db

The Postgres schema for Ponzu Cloud, its migrations, and the queries the API calls.
The architecture it serves is [docs/cloud.md](../../docs/cloud.md). Production is Neon
(Postgres 18); tests run on PGlite, a Postgres inside the test process.

```sh
bun run db:generate                    # after changing src/schema: write the next migration
DATABASE_URL=… bun run db:migrate      # apply what is pending (Neon's direct URL, not the pooled one)
bun test packages/db
```

A test fails if the schema and the migrations disagree. Never edit a migration that has
been applied; change the schema and generate the next one.

PGlite is a single connection, so its races take turns. To race real transactions against
each other, point `PONZU_TEST_DATABASE_URL` at a migrated database (the Neon `dev` branch)
and run `bun test packages/db/src/queries/ops.live.test.ts`. It cleans up after itself.

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
- `@ponzu/db/testing` exports `createTestDb()`: a migrated PGlite database, about 60 ms each.
- Ids are text with a prefix that says what the row is (`des_…`, `usr_…`), made by `newId`.
- Columns named `encrypted_…` hold ciphertext. The key is the API's; this package never sees it.

## Committing ops

`commitOps` appends a batch to `design_ops` and moves `designs.seq` past it in one statement.
The update of the design's row matches only while `seq` is still the caller's `expectedSeq`,
and the insert takes rows only if that update happened. Two callers racing on one seq: the
second waits on the row lock, sees `seq` has moved, writes nothing and gets `{ kind: "conflict" }`.
An op whose id is already in the log is not appended again; the stored op comes back instead.

## Tables

Clients watch the tables marked **live** through Neon Realtime. That puts three rules on them:

- A watched row is sent whole on every change, and one over 4 MiB ends the subscription. So
  content never lives in one: a design's document is in `design_ops` and `design_checkpoints`,
  and clients watch only `designs.seq`, then fetch the ops after their own seq from the API.
- Every table has a primary key.
- A live query is a plain filter or join that names its columns. Never select an
  `encrypted_…` column in one, and sort on the client.

People and access

| Table | What it is for | |
|---|---|---|
| `users` | A person: their WorkOS and GitHub identity, agent defaults, ping settings, onboarding steps. | live |
| `github_user_tokens` | A person's GitHub token, encrypted. Used to ask GitHub what they can reach. | |
| `workspaces` | A GitHub account with the App installed, and its billing: Stripe customer, cap, period anchor. | live |
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
| `jobs` | Work that must finish even if the request that started it does not. The cron takes what is left. | |
| `webhook_deliveries` | Webhooks already taken, so a redelivery is not processed twice. | |

## Deleting

Deleting a design deletes everything that is only its own (ops, checkpoints, thread, events,
questions, sandboxes, tokens, assets). Its usage stays, for the bill. Deleting a person
leaves their designs to the workspace. A workspace or repo cannot be deleted while it has
designs, and a workspace cannot be deleted while it has usage or ledger entries.
