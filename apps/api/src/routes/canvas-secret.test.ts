import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { createQuestion, getCanvasHead, getQuestion, newId } from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import { secretBinding } from "../environments/secrets.ts";
import {
  call,
  canvasWithRunner,
  type StartedRunner,
  startRunner,
  type Workspace,
  workspaceWithRepo,
} from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";

/*
 * Secrets and links the agent asks for (docs/cloud.md, "Needs you"): the runner raises them, a
 * person answers through the API, and a secret's value goes once to the runner of the turn that
 * asked, and nowhere a row, a log or analytics would keep it.
 */

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write", ines: "read" });
});
afterAll(() => t.close());

/** What a person pastes: long enough that a stray copy anywhere is easy to find. */
const VALUE = "sk_test_51Hv8QpLx0-very-secret-value";

const as = (login: string) => ws.people[login]!.headers;
const sample = (repo: "repo" | "scratch" = "repo") =>
  canvasWithRunner(t, ws, "maya", sampleDoc(), repo);

const raise = (runner: StartedRunner, body: unknown) =>
  call(t, runner.headers, "POST", "/v1/runner/questions", body);

async function askFor(runner: StartedRunner, name = "STRIPE_TEST_KEY") {
  const id = newId("q");
  const raised = await raise(runner, {
    id,
    kind: "secret",
    payload: { name, description: "Checkout's test mode needs it." },
  });
  expect(raised.status).toBe(200);
  return id;
}

const give = (canvasId: string, id: string, value: unknown = VALUE, login = "maya") =>
  call(t, as(login), "POST", `/v1/canvases/${canvasId}/questions/${id}/secret`, { value });

const fetchSecret = (runner: StartedRunner, questionId: string) =>
  call(t, runner.headers, "POST", "/v1/runner/secret", { questionId });

/** Every place the value must never be: logs, analytics, the feed, the thread, the question. */
async function nowhere(canvasId: string) {
  const { rows } = (await t.db.execute(
    `select payload::text as p from events where canvas_id = '${canvasId}'
     union all select payload::text from thread_items where canvas_id = '${canvasId}'
     union all select coalesce(answer::text, '') || payload::text from questions where canvas_id = '${canvasId}'
     union all select coalesce(agent_status, '') from canvases where id = '${canvasId}'`,
  )) as unknown as { rows: { p: string }[] };
  expect(JSON.stringify(rows)).not.toContain(VALUE);
  expect(JSON.stringify(t.logs)).not.toContain(VALUE);
  expect(JSON.stringify(t.analytics.events)).not.toContain(VALUE);
}

describe("a secret the agent asks for", () => {
  test("is kept sealed with the repo's secrets, and the agent is told its name alone", async () => {
    const { canvas, runner } = await sample();
    const id = await askFor(runner);
    expect((await getCanvasHead(t.db, canvas.id))!.needsYouCount).toBe(1);

    const given = await give(canvas.id, id);

    expect([given.status, given.body]).toEqual([200, { id, status: "answered" }]);
    expect((await getCanvasHead(t.db, canvas.id))!.needsYouCount).toBe(0);
    expect((await feedOf(t.db, canvas.id)).map((e) => [e.kind, e.priority, e.payload])).toEqual([
      [
        "answer",
        "now",
        {
          questionId: id,
          question: {
            kind: "secret",
            payload: { name: "STRIPE_TEST_KEY", description: "Checkout's test mode needs it." },
          },
          secret: { name: "STRIPE_TEST_KEY" },
        },
      ],
    ]);
    const { rows } = (await t.db.execute(
      `select encrypted_value from repo_secrets where repo_id = '${ws.repo.id}' and name = 'STRIPE_TEST_KEY'`,
    )) as unknown as { rows: { encrypted_value: string }[] };
    expect(
      await t.deps.vault.open(
        rows[0]!.encrypted_value,
        secretBinding(ws.repo.id, "STRIPE_TEST_KEY"),
      ),
    ).toBe(VALUE);
    // Read back, the question says who answered and never what.
    const read = await call(t, as("ines"), "GET", `/v1/canvases/${canvas.id}/questions/${id}`);
    expect(read.body).toMatchObject({ status: "answered", answer: null });
    expect(t.analytics.of("question answered").at(-1)?.properties).toMatchObject({
      canvas_id: canvas.id,
      kind: "secret",
    });
    expect(t.analytics.of("repo secret changed").at(-1)?.properties).toMatchObject({
      repo_id: ws.repo.id,
    });
    await nowhere(canvas.id);
  });

  test("goes to the runner that holds the lease once, and not after fifteen minutes", async () => {
    const { canvas, runner } = await sample();
    const other = await sample();
    const id = await askFor(runner, "ONCE_KEY");
    // Not before it is answered.
    expect((await fetchSecret(runner, id)).status).toBe(404);
    await give(canvas.id, id);

    // Not to another canvas's runner, which can name the question but not reach it.
    expect((await fetchSecret(other.runner, id)).status).toBe(404);
    const fetched = await fetchSecret(runner, id);
    expect([fetched.status, fetched.body]).toEqual([200, { name: "ONCE_KEY", value: VALUE }]);
    // Once.
    expect((await fetchSecret(runner, id)).status).toBe(404);
    expect((await getQuestion(t.db, { canvasId: canvas.id, id }))!.deliveredAt).toBeInstanceOf(
      Date,
    );

    // Answered sixteen minutes ago: the next start's environment carries it, not this route.
    const late = await askFor(runner, "LATE_KEY");
    await give(canvas.id, late);
    await t.db.execute(
      `update questions set answered_at = now() - interval '16 minutes' where id = '${late}'`,
    );
    expect((await fetchSecret(runner, late)).status).toBe(404);
    await nowhere(canvas.id);
  });

  test("is not handed to a runner a newer one took the lease from", async () => {
    const { canvas, runner } = await sample();
    const id = await askFor(runner, "LEASED_KEY");
    await give(canvas.id, id);
    const newer = await startRunner(t, canvas.id);

    const stale = await fetchSecret(runner, id);
    expect([stale.status, stale.body.error.code]).toEqual([409, "superseded"]);
    expect((await fetchSecret(newer, id)).body).toEqual({ name: "LEASED_KEY", value: VALUE });
  });

  test("answered twice: the first wins and the second is told who", async () => {
    const { canvas, runner } = await sample();
    const id = await askFor(runner, "TWICE_KEY");

    await give(canvas.id, id, "first-value-123456");
    const second = await give(canvas.id, id, "second-value-123456");

    expect([second.status, second.body.error.code]).toEqual([409, "question_closed"]);
    expect(second.body.error.details.answeredBy.login).toBe("maya");
    expect((await fetchSecret(runner, id)).body.value).toBe("first-value-123456");
  });

  test("refusals: Scratch, a reserved name, another kind, a reader, a bad value, a full repo", async () => {
    const { canvas, runner } = await sample();
    const code = async (answer: Promise<{ status: number; body: any }>) => {
      const { status, body } = await answer;
      return [status, body.error?.code];
    };

    // The runner may not ask on Scratch, nor for a reserved name.
    const scratch = await sample("scratch");
    expect(
      await code(
        raise(scratch.runner, {
          id: newId("q"),
          kind: "secret",
          payload: { name: "STRIPE_TEST_KEY", description: null },
        }),
      ),
    ).toEqual([409, "no_repository"]);
    expect(
      await code(
        raise(runner, {
          id: newId("q"),
          kind: "secret",
          payload: { name: "ANTHROPIC_API_KEY", description: null },
        }),
      ),
    ).toEqual([400, "secret_name_reserved"]);
    expect(
      await code(
        raise(runner, {
          id: newId("q"),
          kind: "secret",
          payload: { name: "lower case", description: null },
        }),
      ),
    ).toEqual([400, "invalid_request"]);

    // A question that reached the table some other way is refused on the way in all the same.
    const onScratch = await createQuestion(t.db, {
      canvasId: scratch.canvas.id,
      kind: "secret",
      payload: { name: "STRIPE_TEST_KEY", description: null },
    });
    expect(await code(give(scratch.canvas.id, onScratch.id))).toEqual([409, "no_repository"]);
    const reserved = await createQuestion(t.db, {
      canvasId: canvas.id,
      kind: "secret",
      payload: { name: "PONZU_RUNNER_TOKEN", description: null },
    });
    expect(await code(give(canvas.id, reserved.id))).toEqual([400, "secret_name_reserved"]);

    // An ordinary question is not answered with a value, nor a secret through the answer route.
    const plan = newId("q");
    await raise(runner, { id: plan, kind: "plan", payload: { plan: "1. Draw" } });
    expect(await code(give(canvas.id, plan))).toEqual([409, "question_closed"]);
    const id = await askFor(runner, "REFUSED_KEY");
    expect(
      await code(
        call(t, as("maya"), "POST", `/v1/canvases/${canvas.id}/questions/${id}/answer`, {
          approved: true,
        }),
      ),
    ).toEqual([400, "invalid_request"]);

    // Read access may not give one; nor an empty value, a NUL, or more than 16 KB.
    expect(await code(give(canvas.id, id, VALUE, "ines"))).toEqual([403, "forbidden"]);
    for (const value of ["", "a\u0000b", "x".repeat(16 * 1024 + 1)]) {
      expect(await code(give(canvas.id, id, value))).toEqual([400, "invalid_request"]);
    }
    expect(await code(give(canvas.id, "q_0000000000000000"))).toEqual([404, "not_found"]);

    // A repo at fifty secrets takes no fifty-first, and the question stays open.
    const { rows } = (await t.db.execute(
      `select count(*)::int as n from repo_secrets where repo_id = '${ws.repo.id}'`,
    )) as unknown as { rows: { n: number }[] };
    const sealed = await t.deps.vault.seal("v", secretBinding(ws.repo.id, "FILL"));
    for (let i = rows[0]!.n; i < 50; i++) {
      await t.db.execute(
        `insert into repo_secrets (repo_id, name, encrypted_value, value_bytes)
         values ('${ws.repo.id}', 'FILL_${i}', '${sealed}', 1)`,
      );
    }
    expect(await code(give(canvas.id, id))).toEqual([409, "secrets_full"]);
    expect((await getQuestion(t.db, { canvasId: canvas.id, id }))!.status).toBe("open");
    await t.db.execute(
      `delete from repo_secrets where repo_id = '${ws.repo.id}' and name like 'FILL_%'`,
    );
    await nowhere(canvas.id);
  });
});

describe("a link the agent hands off", () => {
  test("is raised with a web address only, and answered done or not now", async () => {
    const { canvas, runner } = await sample();
    const id = newId("q");
    const payload = {
      title: "Sign in to Linear",
      url: "https://linear.app/oauth/authorize?x=1",
      description: "The Linear MCP server needs you to sign in.",
    };

    const notWeb = await raise(runner, {
      id: newId("q"),
      kind: "handoff",
      payload: { ...payload, url: "javascript:alert(1)" },
    });
    const raised = await raise(runner, { id, kind: "handoff", payload });
    const missing = await call(
      t,
      as("maya"),
      "POST",
      `/v1/canvases/${canvas.id}/questions/${id}/answer`,
      { note: "hm" },
    );
    const done = await call(
      t,
      as("maya"),
      "POST",
      `/v1/canvases/${canvas.id}/questions/${id}/answer`,
      { approved: true, note: "dropped" },
    );

    expect(notWeb.status).toBe(400);
    expect(raised.status).toBe(200);
    expect(missing.status).toBe(400);
    expect(done.body).toEqual({ id, status: "answered" });
    expect((await feedOf(t.db, canvas.id)).map((e) => e.payload)).toEqual([
      { questionId: id, question: { kind: "handoff", payload }, approved: true },
    ]);
  });
});
