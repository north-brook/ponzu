import { describe, expect, test } from "bun:test";
import { ApiError } from "@ponzu/client";
import { createFakeBackend } from "@ponzu/client/testing";
import { NEEDS_YOU } from "../copy";
import { AskStore, refusal } from "./ask-store";

/*
 * The phone's needs-you (ask-store.ts) over the client's fake backend: the open asks in the
 * order they were asked, an answer sent once, a teammate's answer elsewhere, a 409, a withdrawn
 * question, an answer that doesn't go, and a secret by its own route.
 */

const BLUE = {
  kind: "question" as const,
  payload: {
    questions: [
      {
        header: "Button colour",
        question: "Which blue for the buttons?",
        options: [
          { label: "Royal", description: "" },
          { label: "Sky", description: "" },
        ],
        multiSelect: false,
      },
    ],
  },
};

async function world() {
  const fake = createFakeBackend();
  const maya = fake.addPerson({ login: "maya", name: "Maya Lin" });
  const sam = fake.addPerson({ login: "sam", name: "Sam Ortiz" });
  const acme = fake.addWorkspace({
    login: "acme",
    members: { [maya.id]: "admin", [sam.id]: "member" },
    repos: [{ name: "site" }],
  });
  const client = fake.connect(maya);
  const canvas = await client.api.canvases.create({
    workspaceId: acme.id,
    repoId: acme.repos[0]!.id,
    name: "Pricing page",
  });
  const agent = fake.agent(canvas.id);
  const store = new AskStore({
    api: client.api,
    live: client.live,
    canvasId: canvas.id,
    meId: maya.id,
  }).start();
  return { fake, maya, sam, client, canvasId: canvas.id, agent, store };
}

/** Waits for what the store holds to satisfy `ok`, by its own changes: no sleeping. */
function until(store: AskStore, ok: () => boolean): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = store.subscribe(() => {
      if (!ok()) return;
      stop();
      resolve();
    });
  });
}

describe("the phone's needs-you", () => {
  test("the open asks, in the order they were asked, each as the Mac's Ask", async () => {
    const { agent, store } = await world();
    const first = agent.ask(BLUE, "Button colour");
    const second = agent.ask({ kind: "plan", payload: { plan: "Three plans.\n\nThen a FAQ." } });
    const third = agent.ask({
      kind: "permission",
      payload: { tool: "Bash", title: "Run the tests", description: null },
    });
    await until(store, () => store.getSnapshot().asks.length === 3);
    const { asks, open, loaded } = store.getSnapshot();
    expect(loaded).toBe(true);
    expect(asks.map((a) => [a.id, a.kind, a.status])).toEqual([
      [first, "question", "open"],
      [second, "plan", "open"],
      [third, "permission", "open"],
    ]);
    expect([...open].sort()).toEqual([first, second, third].sort());
  });

  test("an answer goes once, however often it's sent, and the ask leaves with its row", async () => {
    const { fake, canvasId, agent, store } = await world();
    const id = agent.ask(BLUE, "Button colour");
    await until(store, () => store.getSnapshot().asks.length === 1);
    const answer = { answers: { "Which blue for the buttons?": "Sky" } };
    const sent = [store.answer(id, answer), store.answer(id, answer)];
    // On its way at once: the card shows it sending, and a second press does nothing.
    expect(store.getSnapshot().asks[0]?.status).toBe("sending");
    expect(await Promise.all(sent)).toEqual([true, false]);
    await until(store, () => store.getSnapshot().asks.length === 0);
    const question = fake.canvas(canvasId).questions.find((q) => q.id === id)!;
    expect(question.answer?.body).toEqual(answer);
    expect(store.getSnapshot().said).toBeNull();
  });

  test("a teammate answering elsewhere takes it away; untouched, without a word", async () => {
    const { fake, sam, canvasId, agent, store } = await world();
    const id = agent.ask(BLUE, "Button colour");
    await until(store, () => store.getSnapshot().asks.length === 1);
    await fake
      .connect(sam)
      .api.canvases.answer(canvasId, id, { answers: { "Which blue for the buttons?": "Royal" } });
    await until(store, () => store.getSnapshot().asks.length === 0);
    expect(store.getSnapshot().said).toBeNull();
  });

  test("a teammate answering one the person had started: it goes, and the line names them", async () => {
    const { fake, sam, canvasId, agent, store } = await world();
    const id = agent.ask(BLUE, "Button colour");
    const next = agent.ask({ kind: "plan", payload: { plan: "Three plans." } });
    await until(store, () => store.getSnapshot().asks.length === 2);
    store.touch(id);
    await fake
      .connect(sam)
      .api.canvases.answer(canvasId, id, { answers: { "Which blue for the buttons?": "Royal" } });
    await until(store, () => store.getSnapshot().said?.text === "Sam already answered this.");
    expect(store.getSnapshot().asks.map((a) => a.id)).toEqual([next]);
  });

  test("a 409: the ask leaves at once, the next shows, and the line says who answered", async () => {
    const { fake, sam, canvasId, agent, client } = await world();
    const id = agent.ask(BLUE, "Button colour");
    const next = agent.ask({ kind: "plan", payload: { plan: "Three plans." } });
    // Sam's answer gets there first, while the person's is on its way.
    const api = {
      canvases: {
        ...client.api.canvases,
        answer: async (...args: Parameters<typeof client.api.canvases.answer>) => {
          await fake.connect(sam).api.canvases.answer(canvasId, id, {
            answers: { "Which blue for the buttons?": "Royal" },
          });
          return client.api.canvases.answer(...args);
        },
      },
    };
    const store = new AskStore({ api, live: client.live, canvasId, meId: "me" }).start();
    await until(store, () => store.getSnapshot().asks.length === 2);
    const ok = await store.answer(id, { answers: { "Which blue for the buttons?": "Sky" } });
    expect(ok).toBe(false);
    expect(store.getSnapshot().asks.map((a) => a.id)).toEqual([next]);
    expect(store.getSnapshot().said).toMatchObject({
      text: "Sam already answered this.",
      failed: false,
    });
    // The answer that won is Sam's, once.
    expect(fake.canvas(canvasId).questions.find((q) => q.id === id)?.answer?.userId).toBe(sam.id);
    store.close();
  });

  test("a 409 that names nobody says someone; a withdrawn one says Claude moved on", async () => {
    const { agent, store, client, canvasId } = await world();
    const id = agent.ask(BLUE, "Button colour");
    await until(store, () => store.getSnapshot().asks.length === 1);
    const api = {
      canvases: {
        ...client.api.canvases,
        answer: async () => {
          throw new ApiError(409, "question_closed", "This question is no longer open.");
        },
        // Ponzu can't say how it closed, either.
        question: async () => {
          throw new ApiError(0, "network", "offline");
        },
      },
    };
    const blind = new AskStore({ api, live: client.live, canvasId, meId: "me" }).start();
    await until(blind, () => blind.getSnapshot().asks.length === 1);
    await blind.answer(id, { answers: { "Which blue for the buttons?": "Sky" } });
    expect(blind.getSnapshot().said?.text).toBe(NEEDS_YOU.answered);
    expect(NEEDS_YOU.answered).toBe("Someone already answered this.");
    blind.close();

    // Withdrawn by the run while the person was choosing.
    store.touch(id);
    agent.withdraw(id);
    await until(store, () => store.getSnapshot().said?.text === NEEDS_YOU.movedOn);
    expect(store.getSnapshot().asks).toEqual([]);
  });

  test("an answer that doesn't go: the ask is open again, and the line says why", async () => {
    const { agent, store, client, canvasId } = await world();
    const id = agent.ask(BLUE, "Button colour");
    await until(store, () => store.getSnapshot().asks.length === 1);
    let fails = true;
    const api = {
      canvases: {
        ...client.api.canvases,
        answer: async (...args: Parameters<typeof client.api.canvases.answer>) => {
          if (fails) throw new ApiError(0, "network", "offline");
          return client.api.canvases.answer(...args);
        },
      },
    };
    const flaky = new AskStore({ api, live: client.live, canvasId, meId: "me" }).start();
    await until(flaky, () => flaky.getSnapshot().asks.length === 1);
    const answer = { answers: { "Which blue for the buttons?": "Sky" } };
    expect(await flaky.answer(id, answer)).toBe(false);
    expect(flaky.getSnapshot().asks[0]?.status).toBe("open");
    expect(flaky.getSnapshot().said).toMatchObject({ text: NEEDS_YOU.offline, failed: true });
    fails = false;
    expect(await flaky.answer(id, answer)).toBe(true);
    expect(flaky.getSnapshot().said).toBeNull();
    await until(flaky, () => flaky.getSnapshot().asks.length === 0);
    flaky.close();
    store.close();
  });

  test("a secret goes by its own route, and never in an answer's body", async () => {
    const { fake, canvasId, agent, store } = await world();
    const id = agent.ask({ kind: "secret", payload: { name: "STRIPE_KEY", description: null } });
    await until(store, () => store.getSnapshot().asks.length === 1);
    expect(await store.answer(id, { secret: "sk_test_123" })).toBe(true);
    expect(fake.secretsGiven).toEqual([{ canvasId, name: "STRIPE_KEY", value: "sk_test_123" }]);
    const question = fake.canvas(canvasId).questions.find((q) => q.id === id)!;
    expect(JSON.stringify(question)).not.toContain("sk_test_123");
  });

  test("closed, it hears nothing more", async () => {
    const { agent, store } = await world();
    store.close();
    let heard = 0;
    store.subscribe(() => heard++);
    agent.ask(BLUE, "Button colour");
    await Promise.resolve();
    expect(heard).toBe(0);
  });
});

describe("why an answer didn't go", () => {
  test("in the Mac's words, and at a billing limit only the first sentence and that it waits", () => {
    expect(refusal(new Error("boom"))).toBe("Your answer didn't go through. Send it again.");
    expect(refusal(new ApiError(0, "network", "x"))).toBe(
      "Your answer didn't reach Ponzu. Check your connection and send it again.",
    );
    expect(
      refusal(
        new ApiError(
          402,
          "credits_used_up" as ConstructorParameters<typeof ApiError>[1],
          "Acme's free credits for this month are used up. Add a card on your Mac to keep going.",
        ),
      ),
    ).toBe("Acme's free credits for this month are used up. This canvas waits.");
    expect(refusal(new ApiError(409, "no_repository", "x"))).toBe(
      "A Scratch canvas has no repository to keep a secret with.",
    );
  });
});
