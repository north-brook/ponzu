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
  const opened: string[] = [];
  const client = backend.connect(me);
  const session = signedOutUntilAsked(client.session, me);
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
  };
  const world = window.ponzuFake;

  return {
    session,
    api: client.api,
    live: client.live,
    lights: "drawn",
    async signIn() {
      world.signInsStarted++;
      if (held) await held.promise;
      // The first back signs in; the rest find the person signed in already, as the shell's do.
      if (session.getState().status !== "signed_in") {
        await session.completeSignIn({ code: "fake", codeVerifier: "fake" });
      }
      return { ok: true };
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

/** The fake session, but signed out until the sign-in screen's button is pressed. */
function signedOutUntilAsked(session: Session, me: FakePerson): Session {
  let state: SessionState = { status: "signed_out" };
  const listeners = new Set<() => void>();
  const set = (next: SessionState) => {
    state = next;
    for (const listener of listeners) listener();
  };
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
