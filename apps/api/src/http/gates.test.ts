import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sampleDoc } from "@ponzu/core/fixtures";
import { createQuestion, listThreadItems } from "@ponzu/db";
import { feedOf } from "@ponzu/db/testing";
import { call, canvasIn, type Workspace, workspaceWithRepo } from "../testing/canvases.ts";
import { createTestApp, type TestApp } from "../testing/index.ts";
import { ApiError } from "./errors.ts";
import {
  askSteerGates,
  type NamedRequestGate,
  type RequestGate,
  STEER_GATES,
  type SteerRequest,
} from "./gates.ts";

/*
 * The steer gates: asked in order before a person's message, answer or create is written, the
 * first refusal answering the request. Each lets everything through until its feature fills it.
 */

let t: TestApp;
let ws: Workspace;
beforeAll(async () => {
  t = await createTestApp();
  ws = await workspaceWithRepo(t, { maya: "write" });
});
afterAll(() => t.close());

const as = async (login: string) => (await t.signInAs({ login })).headers;

/** Fill one of the steer gates for the length of a test, as its feature will. */
async function filling<T>(name: string, gate: RequestGate, run: () => Promise<T>): Promise<T> {
  const slot = STEER_GATES.find((g) => g.name === name)! as { gate: RequestGate };
  const was = slot.gate;
  slot.gate = gate;
  try {
    return await run();
  } finally {
    slot.gate = was;
  }
}

const refuse: RequestGate = async () => {
  throw new ApiError(403, "forbidden", "Not now.");
};

const wakeJobs = async (canvasId: string) =>
  (
    (await t.db.execute(
      `select id from jobs where kind = 'sandbox.wake' and key = '${canvasId}'`,
    )) as unknown as { rows: unknown[] }
  ).rows;

describe("the steer gates", () => {
  test("are the rate limit, maintenance and billing, in that order, and let everything through", async () => {
    expect(STEER_GATES.map((g) => g.name)).toEqual(["rateLimit", "maintenance", "billing"]);
    const request: SteerRequest = {
      action: "message",
      userId: "usr_1",
      workspaceId: "ws_1",
      canvasId: "cnv_1",
      withMessage: true,
      request: new Request("http://api.test/v1/canvases/cnv_1/messages"),
    };
    await askSteerGates(t.deps, request);
  });

  test("are asked in order, and the first that refuses stops the rest", async () => {
    const table: { refusing: number | null; asked: string[] }[] = [
      { refusing: null, asked: ["a", "b", "c"] },
      { refusing: 0, asked: ["a"] },
      { refusing: 1, asked: ["a", "b"] },
      { refusing: 2, asked: ["a", "b", "c"] },
    ];
    for (const { refusing, asked } of table) {
      const seen: string[] = [];
      const gates: NamedRequestGate[] = ["a", "b", "c"].map((name, i) => ({
        name,
        gate: async (deps, request) => {
          seen.push(name);
          if (i === refusing) await refuse(deps, request);
        },
      }));
      const request = { action: "answer" } as SteerRequest;
      const asking = askSteerGates(t.deps, request, gates);
      if (refusing === null) await asking;
      else await expect(asking).rejects.toMatchObject({ status: 403, code: "forbidden" });
      expect(seen).toEqual(asked);
    }
  });
});

describe("a refusal", () => {
  test("answers a message before anything is written or woken", async () => {
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    const asked: SteerRequest[] = [];
    const posted = await filling(
      "billing",
      async (deps, request) => {
        asked.push(request);
        await refuse(deps, request);
      },
      async () =>
        call(t, await as("maya"), "POST", `/v1/canvases/${canvas.id}/messages`, { text: "Hi" }),
    );
    await t.backgroundDone();

    expect([posted.status, posted.body.error.code]).toEqual([403, "forbidden"]);
    expect(asked).toMatchObject([
      {
        action: "message",
        userId: ws.people.maya!.userId,
        workspaceId: ws.id,
        canvasId: canvas.id,
        withMessage: true,
      },
    ]);
    expect(await listThreadItems(t.db, { canvasId: canvas.id })).toEqual([]);
    expect(await feedOf(t.db, canvas.id)).toEqual([]);
    expect(await wakeJobs(canvas.id)).toEqual([]);
  });

  test("answers an answer before the question is closed", async () => {
    const canvas = await canvasIn(t, ws, "maya", sampleDoc());
    const question = await createQuestion(t.db, {
      canvasId: canvas.id,
      kind: "question",
      payload: {
        questions: [
          {
            header: "Headline",
            question: "Which way?",
            options: [
              { label: "Shorten it", description: "Two lines." },
              { label: "Let it wrap", description: "Three lines." },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    const path = `/v1/canvases/${canvas.id}/questions/${question.id}/answer`;
    const body = { answers: { "Which way?": "Shorten it" } };
    const refused = await filling("maintenance", refuse, async () =>
      call(t, await as("maya"), "POST", path, body),
    );
    expect(refused.status).toBe(403);
    expect(await feedOf(t.db, canvas.id)).toEqual([]);

    // Once the gate lets it through, the same answer goes in.
    const answered = await call(t, await as("maya"), "POST", path, body);
    expect(answered.status).toBe(200);
  });

  test("answers a create before the canvas is made; a create without a message is asked too", async () => {
    const asked: SteerRequest[] = [];
    const create = async (body: Record<string, unknown>) =>
      call(t, await as("maya"), "POST", "/v1/canvases", {
        workspaceId: ws.id,
        repoId: ws.repo.id,
        ...body,
      });
    const refused = await filling(
      "rateLimit",
      async (deps, request) => {
        asked.push(request);
        await refuse(deps, request);
      },
      async () => {
        const withMessage = await create({
          message: { text: "A pricing page" },
          createKey: "gate-key-1",
        });
        const bare = await create({ createKey: "gate-key-2" });
        return [withMessage, bare];
      },
    );
    expect(refused.map((r) => r.status)).toEqual([403, 403]);
    expect(asked).toMatchObject([
      { action: "create", workspaceId: ws.id, canvasId: null, withMessage: true },
      { action: "create", workspaceId: ws.id, canvasId: null, withMessage: false },
    ]);

    // Nothing was made: the same create key, sent again once the gate lets it, makes the canvas.
    const made = await create({ message: { text: "A pricing page" }, createKey: "gate-key-1" });
    expect(made.status).toBe(201);
  });
});
