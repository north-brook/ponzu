import { expect, test } from "bun:test";
import { ApiError, type CanvasHeadRow, type MeRow } from "@ponzu/client";
import { createFakeBackend, type FakeAgent, type FakePerson, settle } from "@ponzu/client/testing";
import type { Person } from "../cloud/model.ts";
import { AskStore } from "./ask-store.ts";
import { storePonzu } from "./store-ponzu.ts";
import { agentActivity, branchMoment, shownItems, steerGate, toThreadItem } from "./thread-map.ts";
import { THREAD_PAGE, ThreadStore } from "./thread-store.ts";
import { Uploads } from "./uploads.ts";

/*
 * An open canvas's thread and what its agent waits on, against Ponzu Cloud in memory, which
 * answers as the API does: every kind of item arriving live, a message sent at once and its
 * failure, questions answered by the viewer and by a teammate, a stop, each blocker, and
 * read-only access.
 */

const person = (p: FakePerson): Person => ({
  id: p.id,
  name: p.name ?? p.githubLogin,
  login: p.githubLogin,
  avatarUrl: null,
});

async function world() {
  const backend = createFakeBackend();
  const maya = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const sam = backend.addPerson({ login: "sam", name: "Sam Lee" });
  const ines = backend.addPerson({ login: "ines", name: "Ines" });
  const ws = backend.addWorkspace({
    login: "north-brook",
    members: { [maya.id]: "admin", [sam.id]: "member", [ines.id]: "member" },
    repos: [{ name: "site", access: { [ines.id]: "read" } }],
  });
  const client = backend.connect(maya);
  const canvas = await client.api.canvases.create({
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "Pricing",
  });
  const agent = backend.agent(canvas.id);
  const thread = (who = client, meId = maya.id) =>
    new ThreadStore({
      ponzu: storePonzu(who.api),
      live: who.live,
      canvasId: canvas.id,
      meId,
    }).start();
  const errors: string[] = [];
  const asks = (who = client) =>
    new AskStore({
      ponzu: storePonzu(who.api),
      live: who.live,
      canvasId: canvas.id,
      onError: (m) => errors.push(m),
    }).start();
  const people = new Map([maya, sam, ines].map((p) => [p.id, person(p)]));
  return { backend, maya, sam, ines, ws, client, canvas, agent, thread, asks, errors, people };
}

const ctx = (people: ReadonlyMap<string, Person>) => ({
  people,
  assetsUrl: "https://assets.test/d/",
  doc: null,
});

test("every kind of item arrives live, in order, and a streaming reply grows in place", async () => {
  const w = await world();
  const store = w.thread();
  expect(store.getSnapshot().items).toBeNull();
  await settle();
  expect(store.getSnapshot().items).toEqual([]);

  w.agent.wake();
  const reply = w.agent.say("Reading", { streaming: true });
  const work = w.agent.tool("Drawing Pricing · B", { artboards: ["ab_1"] });
  await settle();
  w.agent.say("Reading the repo and the current page.", { id: reply, streaming: false });
  w.agent.tool("Drew Pricing · B", { id: work, streaming: false, steps: 4, artboards: ["ab_1"] });
  w.agent.fail("turn_failed", "The model stopped.");
  await w.client.api.canvases.stop(w.canvas.id);
  await settle();

  const items = store.getSnapshot().items!.map((item) => toThreadItem(item, ctx(w.people)));
  expect(items.map((i) => i.kind)).toEqual(["notice", "assistant", "tool", "notice", "notice"]);
  expect(items[1]).toMatchObject({
    streaming: false,
    payload: { text: "Reading the repo and the current page." },
  });
  expect(items[2]).toMatchObject({ payload: { label: "Drew Pricing · B", steps: 4 } });
  expect(items[3]).toMatchObject({ payload: { type: "error", code: "turn_failed" } });
  // Who stopped it is the API's word, resolved to the member they are.
  expect(items[4]).toMatchObject({ payload: { type: "stopped", by: { name: "Maya Ortiz" } } });
  expect(agentActivity(undefined)).toEqual({ state: "idle", status: null, sandbox: null });
  store.close();
});

test("a teammate's message and comment carry them, as the members they are", async () => {
  const w = await world();
  const store = w.thread();
  const sam = w.backend.connect(w.sam);
  await sam.api.canvases.sendMessage(w.canvas.id, { text: "Keep the green" });
  await settle();
  // A comment on a 400 × 300 board, pinned at its middle.
  const page = w.backend.canvas(w.canvas.id).sequencer.doc.pages[0]!;
  const root = {
    kind: "el" as const,
    id: "ab_hero",
    tag: "section",
    attrs: {},
    style: { width: "400px", height: "300px" },
    children: [],
  };
  w.agent.commit([
    {
      op: "artboard.create",
      page: page.id,
      index: 0,
      artboard: { id: "ab_hero", name: "Hero", x: 0, y: 0, root },
    },
  ]);
  const author = { kind: "user" as const, id: w.sam.id, name: "Sam Lee" };
  const said = { id: "m_1", author, text: "Calmer here", createdAt: 0 };
  const thread = {
    id: "th_1",
    artboardId: "ab_hero",
    x: 200,
    y: 150,
    status: "open" as const,
    createdAt: 0,
    updatedAt: 0,
    messages: [said],
  };
  await sam.api.canvases.commit(w.canvas.id, [{ id: "op_1", op: { op: "thread.create", thread } }]);
  await settle();
  const doc = w.backend.canvas(w.canvas.id).sequencer.doc;
  const [message, comment] = store
    .getSnapshot()
    .items!.map((i) => toThreadItem(i, { ...ctx(w.people), doc }));
  expect(message).toMatchObject({
    kind: "message",
    payload: { text: "Keep the green", from: { id: w.sam.id, name: "Sam Lee", login: "sam" } },
  });
  // No picture yet: it says where it was left.
  expect(comment).toMatchObject({
    kind: "comment",
    payload: {
      text: "Calmer here",
      artboardName: "Hero",
      pageName: null,
      from: { name: "Sam Lee" },
      picture: null,
    },
  });

  // Sam's app gives it its picture: everyone's thread shows it, from the canvas's files.
  const uploads = await sam.api.canvases.uploadCommentPicture(w.canvas.id, "m_1", {
    light: new Uint8Array([1]),
    dark: new Uint8Array([2]),
  });
  await sam.api.canvases.attachCommentPicture(w.canvas.id, "m_1", uploads);
  await settle();
  const item = store.getSnapshot().items![1]!;
  const shown = toThreadItem(item, { ...ctx(w.people), doc });
  expect(shown.payload).toMatchObject({
    picture: {
      kind: "image",
      light: expect.stringMatching(/^https:\/\/assets\.test\/d\/comments\/m_1-light-\w+\.webp$/),
      dark: expect.stringMatching(/^https:\/\/assets\.test\/d\/comments\/m_1-dark-\w+\.webp$/),
      width: 240,
      height: 160,
    },
  });
  // The viewer's own picture, drawn here, is shown from here: while it is drawn, and after.
  const local = { state: "drawn" as const, light: "blob:light", dark: "blob:dark" };
  const drawing = { state: "drawing" as const, doc, threadId: "th_1" };
  const ownCtx = (picture: typeof local | typeof drawing) => ({
    ...ctx(w.people),
    doc,
    pictures: new Map([["m_1", picture]]),
  });
  expect(toThreadItem(item, ownCtx(drawing)).payload).toMatchObject({
    picture: { kind: "drawing" },
  });
  expect(toThreadItem(item, ownCtx(local)).payload).toMatchObject({
    picture: { kind: "image", light: "blob:light", dark: "blob:dark" },
  });
  // Only its author can give it one.
  await expect(
    w.client.api.canvases.attachCommentPicture(w.canvas.id, "m_1", uploads),
  ).rejects.toThrow();
  store.close();
});

test("a comment on the ground names its page, where the canvas has more than one", async () => {
  const w = await world();
  const store = w.thread();
  const sam = w.backend.connect(w.sam);
  const doc = () => w.backend.canvas(w.canvas.id).sequencer.doc;
  const first = doc().pages[0]!;
  const author = { kind: "user" as const, id: w.sam.id, name: "Sam Lee" };
  const thread = {
    id: "th_open",
    pageId: first.id,
    x: -60,
    y: 40,
    status: "open" as const,
    createdAt: 0,
    updatedAt: 0,
    messages: [{ id: "m_open", author, text: "Between these", createdAt: 0 }],
  };
  await sam.api.canvases.commit(w.canvas.id, [{ id: "op_o", op: { op: "thread.create", thread } }]);
  await settle();
  const [item] = store.getSnapshot().items!.filter((i) => i.kind === "comment");
  expect(item!.payload).toMatchObject({ pageId: first.id, at: { x: -60, y: 40 } });
  expect(toThreadItem(item!, { ...ctx(w.people), doc: doc() }).payload).toMatchObject({
    artboardName: null,
    pageName: null,
  });
  w.agent.commit([{ op: "page.create", index: 1, page: { id: "pg_more", name: "More" } }]);
  expect(toThreadItem(item!, { ...ctx(w.people), doc: doc() }).payload).toMatchObject({
    pageName: first.name,
  });
  store.close();
});

test("a message shows at once, then is the thread's own; one that fails stays, to send again", async () => {
  const w = await world();
  const store = w.thread();
  await settle();
  store.send("Make the middle plan stand out", []);
  // In the thread before the API has answered.
  expect(store.getSnapshot().pending).toMatchObject([
    { text: "Make the middle plan stand out", status: "sending" },
  ]);
  await settle();
  const { items, pending } = store.getSnapshot();
  expect(pending).toEqual([]);
  expect(items!.map((i) => i.kind === "message" && i.payload.text)).toEqual([
    "Make the middle plan stand out",
  ]);
  // It went to the canvas's feed as the viewer's.
  expect(w.backend.canvas(w.canvas.id).thread.map((e) => e.userId)).toEqual([w.maya.id]);

  w.backend.online = false;
  store.send("And a fourth plan", []);
  await settle();
  const failed = store.getSnapshot().pending[0]!;
  expect(failed).toMatchObject({ text: "And a fourth plan", status: "failed" });

  w.backend.online = true;
  store.retry(failed.id);
  expect(store.getSnapshot().pending[0]?.status).toBe("sending");
  await settle();
  expect(store.getSnapshot().pending).toEqual([]);
  expect(store.getSnapshot().items).toHaveLength(2);

  w.backend.online = false;
  store.send("Never mind", []);
  await settle();
  store.discard(store.getSnapshot().pending[0]!.id);
  expect(store.getSnapshot().pending).toEqual([]);
  store.close();
});

test("a message the live rows hold before the API answers shows once, not twice", async () => {
  const w = await world();
  // The API commits the message, then wakes the agent before it answers: the live row lands first.
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const api = {
    canvases: {
      ...w.client.api.canvases,
      sendMessage: async (...args: Parameters<typeof w.client.api.canvases.sendMessage>) => {
        const item = await w.client.api.canvases.sendMessage(...args);
        await held;
        return item;
      },
    },
  };
  const store = new ThreadStore({
    ponzu: storePonzu({ ...w.client.api, ...api }),
    live: w.client.live,
    canvasId: w.canvas.id,
    meId: w.maya.id,
  }).start();
  await settle();
  // An older message with the same words is not this one.
  await w.client.api.canvases.sendMessage(w.canvas.id, { text: "Add a yearly toggle" });
  await settle();
  store.send("Add a yearly toggle", []);
  expect(store.getSnapshot().pending).toHaveLength(1);
  await settle();
  const texts = (snap = store.getSnapshot()) =>
    snap
      .items!.filter((i) => i.kind === "message")
      .map((i) => i.kind === "message" && i.payload.text);
  // The live row has it: the bubble gives way, while the API still hasn't answered.
  expect(store.getSnapshot().pending).toEqual([]);
  expect(texts()).toEqual(["Add a yearly toggle", "Add a yearly toggle"]);
  answer();
  await settle();
  expect(store.getSnapshot().pending).toEqual([]);
  expect(texts()).toHaveLength(2);
  store.close();
});

test("history comes a page at a time until the live rows have the whole thread", async () => {
  const w = await world();
  for (let i = 0; i < THREAD_PAGE + 5; i++) w.agent.say(`Line ${i}`);
  // Without live rows (a realtime that never connects), the newest page paints first.
  const live = { subscribe: () => () => {} };
  const store = new ThreadStore({
    ponzu: storePonzu(w.client.api),
    live,
    canvasId: w.canvas.id,
    meId: w.maya.id,
  }).start();
  await settle();
  expect(store.getSnapshot().items).toHaveLength(THREAD_PAGE);
  expect(store.getSnapshot().older).toBe("more");
  store.loadOlder();
  expect(store.getSnapshot().older).toBe("loading");
  await settle();
  expect(store.getSnapshot().items).toHaveLength(THREAD_PAGE + 5);
  expect(store.getSnapshot().older).toBe("none");
  store.close();

  const whole = w.thread();
  await settle();
  expect(whole.getSnapshot().items).toHaveLength(THREAD_PAGE + 5);
  expect(whole.getSnapshot().older).toBe("none");
  whole.close();
});

test("an image uploads as it is added, and goes with the next message", async () => {
  const w = await world();
  const uploads = new Uploads({
    ponzu: storePonzu(w.client.api),
    canvasId: w.canvas.id,
    preview: (file) => `blob:${file.name}`,
    release: () => {},
  });
  const store = w.thread();
  await settle();
  uploads.add([new File([new Uint8Array([1, 2, 3])], "sketch.png", { type: "image/png" })]);
  expect(uploads.getSnapshot()).toMatchObject([{ name: "sketch.png", status: "uploading" }]);
  await settle();
  expect(uploads.getSnapshot()[0]?.status).toBe("ready");
  const attachments = uploads.take();
  expect(attachments).toMatchObject([{ url: "blob:sketch.png", contentType: "image/png" }]);
  expect(uploads.getSnapshot()).toEqual([]);

  store.send("Like this", attachments);
  await settle();
  const item = toThreadItem(store.getSnapshot().items![0]!, ctx(w.people));
  expect(item.kind === "message" && item.payload.attachments).toEqual([
    {
      ref: attachments[0]!.ref,
      url: `https://assets.test/d/${attachments[0]!.ref}`,
      contentType: "image/png",
    },
  ]);

  w.backend.online = false;
  uploads.add([new File([new Uint8Array([4])], "two.png", { type: "image/png" })]);
  await settle();
  const [failed] = uploads.getSnapshot();
  expect(failed?.status).toBe("failed");
  w.backend.online = true;
  uploads.retry(failed!.id);
  await settle();
  expect(uploads.getSnapshot()[0]?.status).toBe("ready");
  uploads.close();
  store.close();
});

const HEADLINE: Parameters<FakeAgent["ask"]>[0] = {
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
};

test("a question waits in the composer's place, and the viewer's answer closes it", async () => {
  const w = await world();
  const store = w.asks();
  const id = w.agent.ask(HEADLINE, "Headline");
  await settle();
  expect(store.getSnapshot()).toMatchObject([
    { id, kind: "question", status: "open", questions: [{ question: "Which way?" }] },
  ]);
  store.answer(id, { answers: { "Which way?": "Shorten it" } });
  expect(store.getSnapshot()[0]?.status).toBe("sending");
  await settle();
  expect(store.getSnapshot()).toEqual([]);
  expect(w.backend.canvas(w.canvas.id).questions[0]?.answer).toEqual({
    userId: w.maya.id,
    body: { answers: { "Which way?": "Shorten it" } },
  });
  store.close();
});

test("a plan and a permission are answered yes or no, with a note", async () => {
  const w = await world();
  const store = w.asks();
  const plan = w.agent.ask({ kind: "plan", payload: { plan: "1. Draw three plans" } }, "Plan");
  const tool = w.agent.ask(
    { kind: "permission", payload: { tool: "Bash", title: "Run the tests", description: "" } },
    "Permission",
  );
  await settle();
  expect(store.getSnapshot().map((a) => a.kind)).toEqual(["plan", "permission"]);
  expect(store.getSnapshot()[1]).toMatchObject({ title: "Run the tests", description: null });
  store.answer(plan, { approved: false, note: "Two plans" });
  store.answer(tool, { approved: true });
  await settle();
  const answers = w.backend.canvas(w.canvas.id).questions.map((q) => q.answer?.body);
  expect(answers).toEqual([{ approved: false, note: "Two plans" }, { approved: true }]);
  store.close();
});

test("a secret goes by its own route and never into the question; a link is done or not now", async () => {
  const w = await world();
  const store = w.asks();
  const secret = w.agent.ask(
    { kind: "secret", payload: { name: "STRIPE_TEST_KEY", description: "For test mode." } },
    "Secret",
  );
  const link = w.agent.ask(
    {
      kind: "handoff",
      payload: { title: "Sign in to Linear", url: "https://linear.app/x", description: null },
    },
    "Over to you",
  );
  await settle();
  expect(store.getSnapshot()).toMatchObject([
    { id: secret, kind: "secret", name: "STRIPE_TEST_KEY", description: "For test mode." },
    { id: link, kind: "link", title: "Sign in to Linear", url: "https://linear.app/x" },
  ]);

  store.answer(secret, { secret: "sk_test_value_123" });
  store.answer(link, { approved: false });
  await settle();

  expect(w.backend.secretsGiven).toEqual([
    { canvasId: w.canvas.id, name: "STRIPE_TEST_KEY", value: "sk_test_value_123" },
  ]);
  const answers = w.backend.canvas(w.canvas.id).questions.map((q) => q.answer?.body);
  expect(answers).toEqual([{}, { approved: false }]);
  expect(JSON.stringify(w.backend.canvas(w.canvas.id).questions)).not.toContain(
    "sk_test_value_123",
  );
  expect(store.getSnapshot()).toEqual([]);
  store.close();
});

test("when a teammate answered first, the viewer's answer is turned away calmly", async () => {
  const w = await world();
  const store = w.asks();
  // Sam's app hears nothing: the API decides.
  const sam = w.backend.connect(w.sam);
  const id = w.agent.ask(HEADLINE);
  await settle();
  const answered = sam.api.canvases.answer(w.canvas.id, id, {
    answers: { "Which way?": "Let it wrap" },
  });
  store.answer(id, { answers: { "Which way?": "Shorten it" } });
  await answered;
  await settle();
  // Sam's answer won; Maya's own is kept as answered, by Sam, to put away.
  expect(w.backend.canvas(w.canvas.id).questions[0]?.answer?.userId).toBe(w.sam.id);
  expect(store.getSnapshot()).toMatchObject([
    {
      id,
      status: "answered",
      answeredBy: { id: w.sam.id, login: w.sam.githubLogin },
      given: { answers: { "Which way?": "Let it wrap" } },
    },
  ]);
  expect(w.errors).toEqual([]);
  store.dismiss(id);
  expect(store.getSnapshot()).toEqual([]);
  store.close();
});

test("a question the viewer had started on stays when it leaves without their answer, saying how it closed", async () => {
  const w = await world();
  const store = w.asks();
  const sam = w.backend.connect(w.sam);
  const id = w.agent.ask(HEADLINE);
  const untouched = w.agent.ask(HEADLINE);
  await settle();
  store.touch(id);
  await sam.api.canvases.answer(w.canvas.id, id, { answers: { "Which way?": "Let it wrap" } });
  await sam.api.canvases.answer(w.canvas.id, untouched, {
    answers: { "Which way?": "Let it wrap" },
  });
  await settle();
  // Sam answered while Maya was choosing: his name and his answer, not her choice.
  expect(store.getSnapshot()).toMatchObject([
    {
      id,
      status: "answered",
      answeredBy: { id: w.sam.id },
      given: { answers: { "Which way?": "Let it wrap" } },
    },
  ]);
  store.dismiss(id);
  expect(store.getSnapshot()).toEqual([]);

  // Withdrawn while the viewer was on it: Claude moved on.
  const next = w.agent.ask(HEADLINE);
  await settle();
  store.touch(next);
  w.agent.withdraw(next);
  await settle();
  expect(store.getSnapshot()).toMatchObject([{ id: next, status: "cancelled", answeredBy: null }]);
  store.dismiss(next);

  store.close();

  // When how it closed can't be read, it says only that it no longer waits.
  const unread = new AskStore({
    ponzu: storePonzu({
      ...w.client.api,
      canvases: {
        ...w.client.api.canvases,
        question: () => Promise.reject(new ApiError(404, "not_found", "Gone.")),
      },
    }),
    live: w.client.live,
    canvasId: w.canvas.id,
    onError: () => {},
  }).start();
  const last = w.agent.ask(HEADLINE);
  await settle();
  unread.touch(last);
  w.agent.withdraw(last);
  await settle();
  expect(unread.getSnapshot()).toMatchObject([{ id: last, status: "closed" }]);
  unread.close();
});

test("an open question is in the composer's place, not also a line in the thread", async () => {
  const w = await world();
  const store = w.thread();
  const asks = w.asks();
  w.agent.say("The headline runs to three lines.");
  const id = w.agent.ask(HEADLINE, "Headline");
  await settle();
  const waiting = new Set(asks.getSnapshot().map((a) => a.id));
  const kinds = (open: ReadonlySet<string>) =>
    shownItems(store.getSnapshot().items!, open).map((i) => i.kind);
  expect(kinds(waiting)).toEqual(["assistant"]);
  asks.answer(id, { answers: { "Which way?": "Shorten it" } });
  await settle();
  // Answered, it is part of what happened.
  expect(kinds(new Set(asks.getSnapshot().map((a) => a.id)))).toEqual(["assistant", "notice"]);
  asks.close();
  store.close();
});

test("the branch may have moved after a finished stretch of work or a pull request notice", async () => {
  const w = await world();
  const store = w.thread();
  await settle();
  expect(branchMoment(store.getSnapshot().items!)).toBe(0);
  w.agent.tool("Pushing", { id: "ti_push", streaming: true });
  await settle();
  // Still at work: nothing to read yet.
  expect(branchMoment(store.getSnapshot().items!)).toBe(0);
  w.agent.tool("Pushed", { id: "ti_push", streaming: false });
  await settle();
  const pushed = branchMoment(store.getSnapshot().items!);
  expect(pushed).toBeGreaterThan(0);
  w.agent.say("Done.");
  await settle();
  expect(branchMoment(store.getSnapshot().items!)).toBe(pushed);
  store.close();
});

test("a withdrawn question leaves, and an answer that can't reach Ponzu says so", async () => {
  const w = await world();
  const store = w.asks();
  const gone = w.agent.ask(HEADLINE);
  await settle();
  w.agent.withdraw(gone);
  await settle();
  expect(store.getSnapshot()).toEqual([]);

  const id = w.agent.ask(HEADLINE);
  await settle();
  w.backend.online = false;
  store.answer(id, { answers: { "Which way?": "Shorten it" } });
  await settle();
  expect(store.getSnapshot()).toMatchObject([{ id, status: "open" }]);
  expect(w.errors).toEqual([
    "Your answer didn't reach Ponzu. Check your connection and send it again.",
  ]);
  store.close();
});

test("each blocker is what keeps the canvas from running, in the composer or the thread's foot", async () => {
  const w = await world();
  const maya = w.people.get(w.maya.id)!;
  const repo = { id: w.ws.repos[0]!.id, owner: "north-brook", name: "site" };
  const head = (agentBlocker: CanvasHeadRow["agentBlocker"]) => ({
    agentState: "idle" as const,
    agentStatus: null,
    agentBlocker,
  });
  const gate = (blocker: CanvasHeadRow["agentBlocker"], owner: Person | null = maya) =>
    steerGate({ access: "write", repo, head: head(blocker), owner, me: undefined, now: 0 });

  expect(gate(null)).toBeNull();
  expect(gate("claude_not_connected")).toEqual({ kind: "claude_disconnected", owner: maya });
  expect(gate("claude_expired")).toEqual({ kind: "claude_expired", owner: maya });
  expect(gate("claude_owner_left")).toEqual({ kind: "claude_owner_left" });
  // An owner the workspace no longer has can't be named.
  expect(gate("claude_not_connected", null)).toEqual({ kind: "claude_owner_left" });
  // A machine to run on is the sandbox's, not anyone's Claude: messages are still taken.
  expect(gate("sandbox_busy")).toBeNull();
  expect(agentActivity(head("sandbox_busy")).sandbox).toBe("busy");
  expect(agentActivity(head("sandbox_failed")).sandbox).toBe("failed");

  // The viewer's own plan at its limit, from their `me` row.
  const limitedUntil = new Date(10_000).toISOString();
  const me = { id: w.maya.id, claudeAccount: { limitedUntil } } as MeRow;
  expect(
    steerGate({ access: "write", repo, head: head(null), owner: maya, me, now: 5_000 }),
  ).toEqual({ kind: "claude_limit", owner: maya, until: limitedUntil });
  expect(
    steerGate({ access: "write", repo, head: head(null), owner: maya, me, now: 20_000 }),
  ).toBeNull();

  // The live head carries the blocker the API sets.
  w.agent.block("sandbox_busy");
  const view = await w.client.api.canvases.get(w.canvas.id);
  expect(view.agentBlocker).toBe("sandbox_busy");
});

test("someone who may only read sees the thread and is told so, and can't send or answer", async () => {
  const w = await world();
  const ines = w.backend.connect(w.ines);
  const view = await ines.api.canvases.get(w.canvas.id);
  expect(view.access).toBe("read");
  const repo = { id: w.ws.repos[0]!.id, owner: "north-brook", name: "site" };
  expect(
    steerGate({ access: view.access, repo, head: undefined, owner: null, me: undefined, now: 0 }),
  ).toEqual({ kind: "read_only", repo });

  w.agent.say("Here are three plans.");
  const store = w.thread(ines, w.ines.id);
  await settle();
  expect(store.getSnapshot().items).toHaveLength(1);
  store.send("Mine", []);
  await settle();
  // The API refuses it; it stays, marked, rather than vanishing.
  expect(store.getSnapshot().pending[0]?.status).toBe("failed");
  const refused = await ines.api.canvases.stop(w.canvas.id).catch((error) => error);
  expect(refused.code).toBe("forbidden");
  store.close();
});
