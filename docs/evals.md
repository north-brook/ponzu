# Evals

How Ponzu measures what its models write: the repo ideas under the create composer, and the
design agent's messages in the thread. One command runs them against the real models, grades
them, and writes a report that is committed, so a change to a prompt, a guide or a judge comes
with its numbers before and after.

```sh
set -a; . .context/cloud.env; set +a     # PONZU_ANTHROPIC_API_KEY, never printed or committed
bun run evals                            # judges, then every suite
bun run evals judges                     # check every judge against its labelled examples
bun run evals ideas --samples 3          # the repo ideas suite
PONZU_EVALS_CLAUDE_TOKEN_FILE=.context/cloud/claude-oauth-token \
  bun run evals agent --turns 6          # the design agent's thread suite
```

Flags: `--samples N` (runs of each ideas case, default 3), `--turns N` (real agent turns, default
6), `--cap USD` or `PONZU_EVALS_SPEND_USD` (default $3), `--only id,id` (some cases or
examples; a partial calibration is never recorded, a partial ideas run is written to
`results/partial.*` and leaves `latest.*` alone, a partial agent run is merged into `latest.*`
with each row saying where its turn ran), `--judge name` (calibrate one judge), `--parallel N`
(cases side by side, default 4).

The cap is hard: a call is refused unless its worst case (all of its output tokens written),
added to what is spent and to the worst cases of the calls still in flight, stays under it. So a
cap needs room for `--parallel` worst cases above what the run will really spend (an Opus judge
call's worst case is about $0.18, a Fable one about $0.36); a calibration stopped by the cap
records nothing. With little budget, use `--parallel 1`.

They cost money and are not deterministic, so `bun test` never runs them: their files are
`*.eval.ts`. The code around them is tested the usual way, with fake models (the harness in
`packages/evals/src/evals.test.ts`, the exact checks in `apps/runner/evals/agent/checks.test.ts`,
the ideas pipeline and its gate in `apps/api/src/ideas/*.test.ts` and
`apps/api/src/routes/repo-ideas.test.ts`).

## The principle

1. **Code checks only what code can decide exactly**: there are exactly four; each is at most
   90 characters; it parses as this schema; this id is in the document; this link's host is
   ours; there is no control character; the spend is under its cap. If a reasonable person could
   look at a case and say "the rule got that wrong", it is not exact, and it is not code.
2. **Anything nuanced is judged by a model against a written rubric**: is this an idea a
   designer could act on, is it about this product, does it avoid talking about how it was made,
   does this message say only what the person needs, was the failure said plainly. No regular
   expressions, word lists, opener lists or n-gram matching stand in for these, in the evals or
   in what guards production.
3. **A judge is itself checked.** Each has a set of labelled examples (clear passes, clear
   failures, hard cases, and the cases that bit us) it must get right before a suite will use
   it. A judge's version is a hash of its model and its prompt; a suite refuses a judge whose
   version has no passing calibration in `results/calibration.json`. A judge is a stronger model
   than what it judges (Sonnet 5.5 and Opus 5.5 over the Haiku 5.5 that writes the ideas),
   answers in a structured form with its reason before each verdict, and its prompt lives in the
   repo beside its examples. **One exception, for now:** the thread judge runs on Claude Opus 5.5,
   the same model as the design agent it grades (at low effort, the agent at high). The stronger
   model is Claude Fable 5.2; moving to it is one constant (`THREAD_JUDGE_MODEL`), but its
   calibration costs about $1 and a rejudge about $0.30, and the budget this was landed on ran out
   part-way through the first try. Move it, recalibrate and `rejudge agent` when there is budget.
4. **Evals are a suite, not anecdotes**: cases with inputs, run against the real models, judged,
   with a readable report, a spend cap and a record of the last run.

## What is checked, and how

| What | Exact (code) | Judged (rubric) | Metrics (never pass/fail) |
|---|---|---|---|
| Repo ideas, at runtime | schema, exactly 4, non-empty, ≤ 90 code points, no control, private-use, lone-surrogate, line/paragraph-separator, bidirectional-control or tag characters (the joiners Persian, Hindi and emoji need are allowed), all different (`checkIdeas`) | the gate, Claude Sonnet 5.5: `safe` (which also fails a phone number, email, handle, wallet, domain or link spelled out in an idea), `design` (`apps/api/src/ideas/gate.ts`) | |
| Repo ideas, offline | the same, on what a person would be shown; a hostile repo never has an unsafe idea shown | the ideas judge, Claude Opus 5.5: per idea `safe`, `design`, `about_product`, `not_meta`, `honest` (fresh only), `specific`, `plain_tile`; per set `four_kinds`, `variety`, `own_words` | attempts, outcome |
| The agent's thread | every ponzu.design link parses as our address, names this design, and its page or board is in the document at the end of the turn; no address pasted as text; no page, board or node id in what a person reads; when the turn made commits, `describe_pull_request` came after the last one; the turn ended with a closing message | the thread judge, Claude Opus 5.5 (see the exception above): `closing`, `mid_turn`, `canvas_detail`, `failures`, `links`, `pr_description` | mid-turn messages, closing characters, links, boards made, commits, minutes, Claude Code's cost |

The runtime gate judges only harm and whether an idea is a design at all. Whether an idea is
specific, honest, in its own words or free of talk about how it was made is measured here and
fixed in the prompt: a false "no" at runtime costs a person their ideas, and the pattern rules
that tried to enforce those turned away a product called ponzu-test for a week.

## Layout

- `packages/evals`: the harness. A spend meter every model call goes through (priced from the
  token usage by a table, refusing a call whose worst case, added to what is spent and to the
  worst cases of the calls still in flight, would pass the cap), a turn budget,
  the judge helper (`generateText` with `Output.object`, through the AI SDK like the product),
  calibration and its record, and the report writer.
- `apps/api/evals/ideas`: the repo cases as checked-in `RepoSnapshot`s (`cases.ts`, made up or
  in the shape of public projects, never a customer's), the ideas judge (`judge.ts`) and its
  labelled sets (`judge.examples.ts`), the gate's labelled sets (`gate.examples.ts`; the gate's
  prompt is production's, in `src/ideas/gate.ts`), and the suite (`ideas.eval.ts`), which runs
  `askForIdeas` exactly as the API does.
- `apps/runner/evals/agent`: the turn harness (`harness.ts`), the seeded designs and repository
  (`seeds.ts`), the exact checks (`checks.ts`), the thread judge (`judge.ts`) and its labelled
  turns (`judge.examples.ts`, verbatim from the hand-run measurements of #448 and #451), and the
  suite (`agent.eval.ts`).
- `results/` beside each: `latest.json` (everything: outputs, verdicts with reasons, exact
  checks, metrics, spend, models, judge versions, commit), `latest.md` (the same for a person),
  `calibration.json` and `calibration.md` (each judge's last calibration). The ideas suite also
  keeps `baseline.md`/`.json`, the run on the pattern rules this replaced, and
  `spot-gate*.md`/`.json`, the spot checks of the gate after it learned to fail spelled-out
  contact details (five cases, then the two hostile ones judged; `latest.*` is the last full run,
  on the gate before that change). History is git.

### The agent harness

Each case is one real turn: the runner (`Runner`) in process against the API in memory
(`FakeRunnerApi`), real Claude Code (the version on the PATH, or `PONZU_CLAUDE`) through the
Agent SDK on a Claude sign-in (`PONZU_EVALS_CLAUDE_TOKEN_FILE`, or `CLAUDE_CODE_OAUTH_TOKEN`;
never an API key), `claude-opus-5-5` at `high` (the design defaults), screenshots from the
newest Playwright Chromium Headless Shell (or `PONZU_CHROMIUM`). Each turn has its own folders,
`HOME` and `CLAUDE_CONFIG_DIR`, so nothing of this machine's Claude or git reaches it. A bare
repository on disk stands in for `github.com/ada/fitness-app` (`url.insteadOf`), so commits and
pushes are real; a case that refuses pushes gets a pre-receive hook that answers "Repository not
found", as GitHub did in the founder's session. A question the agent asks is answered "Your
call." Every case starts from its own seeded design (`seeds.ts`), so none depends on another.

Agent turns run on a person's Claude plan, so they are counted in turns, not dollars; the report
records each turn's cost as Claude Code estimates it. Judging the turns is on the API key and
metered like everything else.

## Changing a prompt, a guide or a judge

1. Run the suite it affects and keep the numbers (`results/latest.md` as committed is "before").
2. Make the change.
3. A judge's rubric or model changed: `bun run evals judges`. Fix the rubric until every label
   is right; change a label only when the judge was right and the label wrong, and say so in the
   pull request.
4. Run the suite again, and commit `results/` with the change: the diff is the before and after.

## Calls left to the founder

- **The language of ideas for a product described in another language** (case I13, Mercadito,
  in Spanish). Today the prompt says nothing, the writer answers in English, and the judge
  scores language on no criterion.
- **How long a direct answer may run.** #448's situation 3 answered a why-question in three
  paragraphs of prose with no board. The thread judge's labelled set pins only that no board was
  needed. The rubric itself still says "a direct question gets a direct answer in two or three
  sentences", which decides the question by default, and A3's recorded `closing` fail cites it
  (it also faults bold bullets, which fail either way). The alternative wording, where the length
  of a plain prose answer never fails `closing` but an answer dressed as an essay does, was tried
  on Claude Fable 5.2 and is not calibrated; whichever the founder picks goes into the rubric,
  then `bun run evals judges agent` and `bun run evals rejudge agent`.
- **PostHog online evaluations** (LLM-as-judge on production traces) need the traces' content,
  which `PONZU_POSTHOG_AI_CONTENT` keeps off in production because it would send repo-derived
  text to PostHog. Turning it on is the founder's call; the same rubrics could then monitor
  production.

## Why our own harness

The standard tools were checked first ("ride the happy path", AGENTS.md), on 2026-11-11:

- **vitest-evals** (getsentry, 0.18.1) is the closest fit, with judges, replay and a reporter,
  but its peer dependencies are `ai >=4 <7` and `vitest >=5 <6`: we are on `ai` 7, its AI SDK
  harness does not support it, and it would add a second test runner beside `bun test`. The
  design agent's cases need their own harness (the runner and Claude Code) either way. Revisit
  when it supports `ai` 7.
- **evalite** is deprecated ("No longer maintained", 0.19.0), pointing to Langfuse.
- **autoevals** (Braintrust, 0.4.1) runs its classifiers on an OpenAI client; reaching Claude
  means going around our AI SDK path, and its stock templates are not our rubrics.
- **Langfuse** would be a new platform and server; we do not need one.
- **PostHog LLM analytics evaluations** judge production traces (blocked on content, above);
  PostHog's offline evaluations (`@posthog/ai/evaluations`, already installed) could store these
  results and chart them across runs, but they keep content 30 days and add nothing the
  committed results lack today. A natural follow-up once there are enough runs to chart.

What is standard is used as it is: every model call goes through the AI SDK (`generateText`
with `Output.object`, the same as the product), and the agent runs through the Claude Agent SDK
exactly as a sandbox does. What is ours is about 300 lines: a case loop, a meter, a judge helper,
calibration and a report.
