import type { Session, SessionState } from "@ponzu/client";
import { createFakeBackend, type FakeBackend, type FakePerson } from "@ponzu/client/testing";
import { type Artboard, newId, newOpId, type Op } from "@ponzu/core";
import type { DeepLink, MacNotice, MenuCommand, PonzuDesktop } from "@ponzu/desktop/bridge";
import type { Beat } from "../cloud/create/landing.ts";
import { signedInCache } from "./desktop-host.ts";
import type { Host, HostNotifications } from "./host.ts";
import { linksWithInstalls } from "./installs.ts";

/*
 * The studio in a plain browser, for development and the headless test: Ponzu Cloud in memory
 * (@ponzu/client/testing) for someone on their first run. Their team's workspace is set up,
 * with a canvas an agent has drawn on; their own GitHub account is not, and its install page
 * finishes at the next sync (as coming back from GitHub does). claude.ai takes any code but one
 * starting "wrong". It starts signed out; Continue with GitHub signs in at once.
 * `window.ponzuFake` hands the test the backend, to play GitHub, the agent and teammates with.
 *
 * Query parameters set the world up for the tests of how the window starts: `latency` slows
 * every answer by that many milliseconds from the first (`jitter`, a seed: by anywhere from none
 * to twice that, each answer its own; `meLatency`: `me` by that much more again), and `as`
 * relaunches signed in, as someone part way through setup (`where`: nothing set up; `claude`:
 * their account set up, Claude not yet connected; `iphone`: Claude connected too) or past it
 * (`returning`). `beat=held` holds the beat after a send from the create page until the test
 * ends it (`beats`).
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
  /** Draw a board on the canvas's first page, as its agent. */
  drawBoard(canvasId: string, name: string, color?: string): string;
  /** Reply in a comment thread, as the teammate. */
  reply(canvasId: string, threadId: string, text: string): Promise<void>;
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
  /** The app's asks of the API: how many it has made, and how many it is still waiting on. */
  answers: { asked: number; waiting: number };
  /**
   * Keep every answer the app asks for from now in hand until `releaseAnswers`: the asks are
   * made, and counted waiting, but none comes back. For a test of what the window shows before
   * an answer is in, so that holds however slowly the machine paints, not only while the
   * answer's `latency` outlasts a frame.
   */
  holdAnswers(): void;
  /** Every held answer comes back, and the ones asked for from now come as they would. */
  releaseAnswers(): void;
  /**
   * With `?beat=held`, the beat after a send from the create page (cloud/create/landing.ts)
   * passes only when `end` says: `waiting` counts the beats under way, each from the moment
   * the composer lands until it ends or the person goes to the thread. Without it, null: the
   * beat runs on the window's clock.
   */
  beats: { readonly waiting: number; end(): void } | null;
  /**
   * The Mac's notifications, played (with `?mac=1`; null otherwise): every banner the studio
   * asked to show and take away, the dock's number, and a click on a banner.
   */
  mac: FakeMac | null;
}

export interface FakeMac {
  shown: MacNotice[];
  removed: string[];
  /** The dock's number as last set; null until it is. */
  badge: number | null;
  /** Click a banner shown: the shell hands its link to the studio. */
  click(id: string): void;
  /** macOS refuses one, as it does an unsigned build's. */
  fail(id: string): void;
}

declare global {
  interface Window {
    ponzuFake?: FakeWorld;
  }
}

/**
 * `shell`: the Mac app's bridge, when a test build runs the studio on this fake
 * (PONZU_FAKE_BACKEND, apps/desktop/src/config.ts), so spare can measure the packaged app. The
 * canvases opened are then kept the way the Mac app keeps them, in the window's localStorage,
 * and the traffic lights are the system's. Everything else is still played here: no session,
 * link or banner reaches the shell.
 */
export function fakeHost(opts: { shell?: PonzuDesktop } = {}): Host {
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
  // `email=1`: an API that can send email (RESEND_API_KEY set), so Settings has its Email group.
  if (params.get("email") === "1") backend.features = { ...backend.features, email: true };
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
  const answers = { asked: 0, waiting: 0 };
  /** While a test holds the answers: what lets them come back. */
  let answersHeld: { promise: Promise<void>; resolve: () => void } | null = null;
  countAnswers(client.api, answers, () => answersHeld?.promise ?? null);
  const session = signedOutUntilAsked(client.session, me, as ? backend.latencyMs : null);
  const links = new Set<(link: DeepLink) => void>();
  const commands = new Set<(command: MenuCommand) => void>();
  // Nothing it opens is a real page: GitHub's and claude.ai's are played by the backend.
  const openExternal = (url: string) => {
    opened.push(url);
  };
  // The fake's GitHub never comes back by itself: a test says how an install went with a link.
  const shellLinks = linksWithInstalls({
    api: client.api,
    shellLinks: (listener) => {
      links.add(listener);
      return () => links.delete(listener);
    },
    openExternal,
    comeForward: () => {},
  });

  const drawBoard = (canvasId: string, name: string, color = "#ffc81e") => {
    const doc = backend.canvas(canvasId).sequencer.doc;
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
    backend.agent(canvasId).commit([op]);
    return id;
  };

  void seed(backend, client.api, workspace.id, workspace.repos[0]!.id, drawBoard, teammate);
  const teammateApi = backend.connect(teammate).api;
  const sendLink = (link: DeepLink) => {
    for (const listener of links) listener(link);
  };
  const mac = params.get("mac") === "1" ? fakeMac(sendLink) : null;
  /** Sign-ins out in the "browser", while a test holds them there. */
  let held: { promise: Promise<void>; resolve: () => void } | null = null;
  /** `?beat=held`: the beats under way, each ended when the test says. */
  const beats = params.get("beat") === "held" ? new Set<() => void>() : null;
  const landingBeat: Beat | undefined = beats
    ? (over) => {
        beats.add(over);
        return () => beats.delete(over);
      }
    : undefined;

  window.ponzuFake = {
    backend,
    me,
    teammate,
    workspaceId: workspace.id,
    personalId: personal.id,
    opened,
    drawBoard,
    async reply(canvasId, threadId, text) {
      const author = { kind: "user" as const, id: teammate.id, name: teammate.name ?? "Sam" };
      const message = { id: newId("m"), author, text, createdAt: Date.now() };
      await teammateApi.canvases.commit(canvasId, [
        { id: newOpId(), op: { op: "thread.message", id: threadId, message } },
      ]);
    },
    link: sendLink,
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
    answers,
    holdAnswers() {
      if (answersHeld) return;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      answersHeld = { promise, resolve };
    },
    releaseAnswers() {
      answersHeld?.resolve();
      answersHeld = null;
    },
    beats: beats && {
      get waiting() {
        return beats.size;
      },
      end() {
        const over = [...beats];
        beats.clear();
        for (const fn of over) fn();
      },
    },
    mac: mac?.world ?? null,
  };
  const world = window.ponzuFake;

  return {
    session,
    api: client.api,
    live: client.live,
    lights: opts.shell ? (opts.shell.platform === "darwin" ? "native" : "none") : "drawn",
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
    onLink: shellLinks.onLink,
    installGithub: shellLinks.installGithub,
    onCommand(listener) {
      commands.add(listener);
      return () => commands.delete(listener);
    },
    update: null,
    openExternal,
    docStorage: opts.shell ? signedInCache(session, window.localStorage) : null,
    notifications: mac?.host ?? null,
    ...(landingBeat ? { landingBeat } : {}),
  };
}

/**
 * The shell's notifications, played as the test's: banners kept in a list rather than shown, and
 * a click handing the banner's link back as the shell does.
 */
function fakeMac(sendLink: (link: DeepLink) => void): { host: HostNotifications; world: FakeMac } {
  const failed = new Set<(id: string) => void>();
  const world: FakeMac = {
    shown: [],
    removed: [],
    badge: null,
    click(id) {
      const notice = [...world.shown].reverse().find((n) => n.id === id);
      if (notice) sendLink(notice.link);
    },
    fail(id) {
      for (const listener of failed) listener(id);
    },
  };
  const host: HostNotifications = {
    supported: true,
    installId: "fake-mac-install-0001",
    deviceName: "Maya's MacBook Pro",
    appVersion: "2.0.0",
    show: (notice) => world.shown.push(notice),
    remove: (ids) => world.removed.push(...ids),
    setBadge: (count) => {
      world.badge = count;
    },
    onFailed(listener) {
      failed.add(listener);
      return () => failed.delete(listener);
    },
  };
  return { host, world };
}

/**
 * Counts, in place, every ask of `api` (each method of it and of the groups in it): Realtime's
 * reads too, which go through the same object. A test waits on `waiting` reaching none rather
 * than for a guess at how long the slowest answer takes. While `held` gives a promise, an
 * answer comes back only once it has settled (holdAnswers).
 */
function countAnswers(
  api: object,
  answers: FakeWorld["answers"],
  held: () => Promise<void> | null,
) {
  const methods = api as Record<string, unknown>;
  for (const [key, value] of Object.entries(methods)) {
    if (typeof value === "function") {
      methods[key] = (...args: unknown[]) => {
        const asked: unknown = value.apply(api, args);
        if (!(asked instanceof Promise)) return asked;
        const gate = held();
        // A refusal while held is the caller's once it comes back, not unhandled before then.
        if (gate) asked.catch(() => {});
        const result = gate ? gate.then(() => asked) : asked;
        answers.asked++;
        answers.waiting++;
        const done = () => {
          answers.waiting--;
        };
        result.then(done, done);
        return result;
      };
    } else if (value && typeof value === "object") {
      countAnswers(value, answers, held);
    }
  }
}

/** One canvas the agent has worked on, so the sidebar and the boards have something in them. */
async function seed(
  backend: FakeBackend,
  api: Host["api"],
  workspaceId: string,
  repoId: string,
  drawBoard: FakeWorld["drawBoard"],
  teammate: FakePerson,
) {
  const canvas = await api.canvases.create({ workspaceId, repoId, name: "Onboarding flow" });
  drawBoard(canvas.id, "Welcome");
  drawBoard(canvas.id, "Pick a repo", "#f4f3ef");
  backend.agent(canvas.id).say("I drew the welcome screen and the repo picker.");
  await backend.connect(teammate).api.canvases.presence(canvas.id);
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
