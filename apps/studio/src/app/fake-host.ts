import type { Session, SessionState } from "@ponzu/client";
import { createFakeBackend, type FakeBackend, type FakePerson } from "@ponzu/client/testing";
import { type Artboard, newId, newOpId, type Op } from "@ponzu/core";
import type { DeepLink, MenuCommand } from "@ponzu/desktop/bridge";
import type { Host } from "./host.ts";

/*
 * The studio in a plain browser, for development and the headless test: Ponzu Cloud in memory
 * (@ponzu/client/testing) for someone on their first run. Their team's workspace is set up,
 * with a design an agent has drawn on; their own GitHub account is not, and its install page
 * finishes at the next sync (as coming back from GitHub does). claude.ai takes any code but one
 * starting "wrong". It starts signed out; Continue with GitHub signs in at once.
 * `window.ponzuFake` hands the test the backend, to play GitHub, the agent and teammates with.
 *
 * Query parameters set the world up for the tests of how the window starts: `latency` slows
 * every answer by that many milliseconds from the first (`jitter`, a seed: by anywhere from none
 * to twice that, each answer its own; `meLatency`: `me` by that much more again), and `as`
 * relaunches signed in, as someone part way through setup (`where`: nothing set up; `claude`:
 * their account set up, Claude not yet connected; `iphone`: Claude connected too) or past it
 * (`returning`).
 */

/** The ideas Maya's own repo gets, once they have been made. */
export const KETTLE_IDEAS = [
  "Make checkout one page, with the order summary on the right",
  "Three takes on the home hero that put the plants first",
  "A dark mode for the shop, using the tokens you already have",
  "Friendlier empty states for cart, orders and search",
];

export interface FakeWorld {
  backend: FakeBackend;
  me: FakePerson;
  teammate: FakePerson;
  workspaceId: string;
  /** Maya's own account, which first run sets up. */
  personalId: string;
  /** Every address the app opened in the system browser. */
  opened: string[];
  /** Draw a board on the design's first page, as its agent. */
  drawBoard(designId: string, name: string, color?: string): string;
  /** Reply in a comment thread, as the teammate. */
  reply(designId: string, threadId: string, text: string): Promise<void>;
  /** Send a ponzu:// link, as the shell would. */
  link(link: DeepLink): void;
  command(command: MenuCommand): void;
  /** Keep sign-ins out in the "browser" until `finishSignIn`, as a real one would be. */
  holdSignIn(): void;
  /** The browser comes back: every held sign-in finishes, the first signing in. */
  finishSignIn(): void;
  /** How many sign-ins the screen has started. */
  signInsStarted: number;
  /** How many of them have ended, signed in or not: only the "browser" ends one. */
  signInsEnded: number;
}

declare global {
  interface Window {
    ponzuFake?: FakeWorld;
  }
}

export function fakeHost(): Host {
  const backend = createFakeBackend();
  const me = backend.addPerson({ login: "maya", name: "Maya Ortiz" });
  const teammate = backend.addPerson({ login: "sam", name: "Sam Lee" });
  const workspace = backend.addWorkspace({
    login: "north-brook",
    name: "Northbrook",
    members: { [me.id]: "admin", [teammate.id]: "member" },
    repos: [{ name: "ponzu" }, { name: "site" }],
  });
  const personal = backend.addWorkspace({
    login: "maya",
    kind: "personal",
    members: { [me.id]: "admin" },
    repos: [{ name: "kettle" }],
    installed: false,
  });
  backend.setIdeas(personal.repos[0]!.id, "generating", KETTLE_IDEAS);
  backend.claude.acceptsCode = (code) => !code.startsWith("wrong");
  const params = new URLSearchParams(window.location.search);
  const latency = Number(params.get("latency")) || 0;
  if (params.has("jitter")) {
    // Each answer takes anywhere from none to twice `latency`, so they arrive out of order.
    let seed = Number(params.get("jitter")) || 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    Object.defineProperty(backend, "latencyMs", { get: () => Math.round(latency * 2 * random()) });
  } else {
    backend.latencyMs = latency;
  }
  const as = params.get("as");
  const stage = ["where", "claude", "iphone", "returning"].indexOf(as ?? "");
  if (stage >= 1) {
    backend.install(personal.id);
    backend.finishStep(me.id, "where");
  }
  if (stage >= 2) backend.claude.connect(me.id);
  if (stage >= 3) backend.finishStep(me.id, "iphone");
  const opened: string[] = [];
  const client = backend.connect(me);
  // `meLatency`: who the person is takes this much longer again than every other answer.
  const meLatency = Number(params.get("meLatency")) || 0;
  if (meLatency > 0) {
    const askMe = client.api.me;
    client.api.me = async () => {
      await new Promise((resolve) => setTimeout(resolve, meLatency));
      return askMe();
    };
  }
  const session = signedOutUntilAsked(client.session, me, as ? backend.latencyMs : null);
  const links = new Set<(link: DeepLink) => void>();
  const commands = new Set<(command: MenuCommand) => void>();

  const drawBoard = (designId: string, name: string, color = "#ffc81e") => {
    const doc = backend.design(designId).sequencer.doc;
    const page = doc.pages[0]!;
    const id = newId("ab");
    const artboard: Artboard = {
      id,
      name,
      x: page.artboards.length * 520,
      y: 0,
      root: {
        kind: "el",
        id,
        tag: "div",
        attrs: {},
        style: {
          width: "480px",
          height: "320px",
          background: color,
          display: "grid",
          "place-items": "center",
        },
        children: [
          {
            kind: "el",
            id: newId("n"),
            tag: "h1",
            attrs: {},
            style: { margin: "0", font: "600 32px Inter, sans-serif", color: "#111110" },
            children: [{ kind: "text", value: name }],
          },
        ],
      },
    };
    const op: Op = { op: "artboard.create", page: page.id, index: page.artboards.length, artboard };
    backend.agent(designId).commit([op]);
    return id;
  };

  void seed(backend, client.api, workspace.id, workspace.repos[0]!.id, drawBoard, teammate);
  const teammateApi = backend.connect(teammate).api;
  /** Sign-ins out in the "browser", while a test holds them there. */
  let held: { promise: Promise<void>; resolve: () => void } | null = null;

  window.ponzuFake = {
    backend,
    me,
    teammate,
    workspaceId: workspace.id,
    personalId: personal.id,
    opened,
    drawBoard,
    async reply(designId, threadId, text) {
      const author = { kind: "user" as const, id: teammate.id, name: teammate.name ?? "Sam" };
      const message = { id: newId("m"), author, text, createdAt: Date.now() };
      await teammateApi.designs.commit(designId, [
        { id: newOpId(), op: { op: "thread.message", id: threadId, message } },
      ]);
    },
    link: (link) => {
      for (const listener of links) listener(link);
    },
    command: (command) => {
      for (const listener of commands) listener(command);
    },
    holdSignIn() {
      if (held) return;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      held = { promise, resolve };
    },
    finishSignIn() {
      held?.resolve();
      held = null;
    },
    signInsStarted: 0,
    signInsEnded: 0,
  };
  const world = window.ponzuFake;

  return {
    session,
    api: client.api,
    live: client.live,
    lights: "drawn",
    async signIn() {
      world.signInsStarted++;
      try {
        if (held) await held.promise;
        // The first back signs in; the rest find the person signed in already, as the shell's do.
        if (session.getState().status !== "signed_in") {
          await session.completeSignIn({ code: "fake", codeVerifier: "fake" });
        }
        return { ok: true };
      } finally {
        world.signInsEnded++;
      }
    },
    persistence: async () => "keychain",
    onLink(listener) {
      links.add(listener);
      return () => links.delete(listener);
    },
    onCommand(listener) {
      commands.add(listener);
      return () => commands.delete(listener);
    },
    update: null,
    // Nothing it opens is a real page: GitHub's and claude.ai's are played by the backend.
    openExternal: (url) => {
      opened.push(url);
    },
    docStorage: null,
  };
}

/** One design the agent has worked on, so the sidebar and a canvas have something in them. */
async function seed(
  backend: FakeBackend,
  api: Host["api"],
  workspaceId: string,
  repoId: string,
  drawBoard: FakeWorld["drawBoard"],
  teammate: FakePerson,
) {
  const design = await api.designs.create({ workspaceId, repoId, name: "Onboarding flow" });
  drawBoard(design.id, "Welcome");
  drawBoard(design.id, "Pick a repo", "#f4f3ef");
  backend.agent(design.id).say("I drew the welcome screen and the repo picker.");
  await backend.connect(teammate).api.designs.presence(design.id);
}

/**
 * The fake session, but signed out until the sign-in screen's button is pressed; or, with
 * `restoreMs`, a relaunch: loading for that long, as a keychain read is, then signed in.
 */
function signedOutUntilAsked(session: Session, me: FakePerson, restoreMs: number | null): Session {
  let state: SessionState = { status: restoreMs === null ? "signed_out" : "loading" };
  const listeners = new Set<() => void>();
  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  if (restoreMs !== null) setTimeout(() => set({ status: "signed_in", user: me }), restoreMs);
  return {
    ...session,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async completeSignIn() {
      set({ status: "signed_in", user: me });
      return me;
    },
    async signOut() {
      set({ status: "signed_out" });
    },
  };
}
