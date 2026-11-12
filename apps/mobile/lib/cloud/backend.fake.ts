import {
  type Api,
  type Live,
  type Profile,
  type Session,
  type SessionState,
  SignInError,
} from "@ponzu/client";
import { createFakeBackend, type FakeBackend, type FakeClient } from "@ponzu/client/testing";
import type { Artboard } from "@ponzu/core";
import type { Backend } from "./types";

/*
 * Ponzu Cloud in memory (`createFakeBackend`, the client's own fake, kept true by its tests),
 * for component tests, Maestro on a simulator and demos with no account. A bundle gets it in
 * backend.ts's place when Metro runs with PONZU_BACKEND=fake; nothing else imports it.
 *
 * Sign-in goes through the app's real auth-session plumbing when EXPO_PUBLIC_PONZU_FAKE_AUTHORIZE_URL
 * names a page that redirects back with `code=fake` (maestro/authorize.ts); without one, the
 * browser is skipped. `ponzu-dev://dev?seed=<scenario>` (app/dev.tsx) puts the app in a state.
 */

/** The code the fake authorize page hands back, and the only one the fake takes. */
export const FAKE_CODE = "fake";

export const SCENARIOS = [
  /** Nobody signed in: the sign-in screen. */
  "signed-out",
  /** Maya, in the acme workspace with three canvases. */
  "signed-in",
  /** Sam, in a personal workspace with no canvases yet. */
  "empty",
  /** GitHub stopped accepting what Ponzu holds: sign in again. */
  "github-reauth",
  /** The API refuses this version. */
  "too-old",
  /** Lee, new: their own account without Ponzu, so "Where do you build?" has nothing ready. */
  "setup-where",
  /** Ava, through "Where do you build?" with no Claude yet: Connect Claude. */
  "setup-claude",
  /**
   * Maya's list in every state (`stockCanvases`): a question for her, the agent working, a
   * preview, a settled canvas, and a second workspace to switch to.
   */
  "canvases",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const isScenario = (name: string): name is Scenario =>
  (SCENARIOS as readonly string[]).includes(name);

/** A session whose sign-in is the fake's: signed out until it is handed `FAKE_CODE`. */
class FakeSignInSession implements Session {
  readonly apiUrl = "https://api.test";
  private state: SessionState = { status: "signed_out" };
  private readonly listeners = new Set<() => void>();
  /** Who signing in makes you. */
  person: Profile;

  constructor(person: Profile) {
    this.person = person;
  }

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(state: SessionState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  fetch = (): Promise<Response> =>
    Promise.reject(new Error("The fake session sends nothing: use the fake api."));

  async completeSignIn(input: { code: string; codeVerifier: string; signal?: AbortSignal }) {
    if (input.signal?.aborted) throw new Error("Sign-in was given up.");
    if (input.code !== FAKE_CODE) {
      throw new SignInError("invalid_grant", "Sign-in did not finish.");
    }
    this.set({ status: "signed_in", user: this.person });
    return this.person;
  }

  async signOut() {
    this.set({ status: "signed_out" });
  }
}

export interface FakeWorld {
  fake: FakeBackend;
  maya: Profile;
  sam: Profile;
  /** New: their own account (`lee`) has no Ponzu yet, and they have never confirmed where. */
  lee: Profile;
  /** Through "Where do you build?" on their own account, with no Claude yet. */
  ava: Profile;
  /** Maya's acme workspace. */
  acme: { id: string; repos: { id: string; fullName: string }[] };
  /** Lee's own account's workspace, not installed. */
  leeAccount: { id: string; githubAccountId: number };
  /** Settles once the world's canvases exist. */
  ready: Promise<void>;
}

/** A phone-sized board with its name as a heading: enough for the canvas to draw. */
function fakeBoard(id: string, name: string, x: number): Artboard {
  return {
    id,
    name,
    x,
    y: 0,
    root: {
      kind: "el",
      id,
      tag: "section",
      name,
      attrs: {},
      style: { width: "390px", height: "640px", background: "#ffffff", padding: "32px" },
      children: [
        {
          kind: "el",
          id: `${id}_title`,
          tag: "h1",
          attrs: {},
          style: { margin: "0", "font-family": "Inter, sans-serif", "font-size": "32px" },
          children: [{ kind: "text", value: name }],
        },
      ],
    },
  };
}

/**
 * Maya in acme with three canvases (the first with two boards), and Sam alone with none, both
 * through setup with Claude connected; Lee and Ava part of the way through it.
 */
export function fakeWorld(fake: FakeBackend = createFakeBackend()): FakeWorld {
  const maya = fake.addPerson({ login: "maya", name: "Maya Lin" });
  const sam = fake.addPerson({ login: "sam", name: "Sam Ortiz" });
  const lee = fake.addPerson({ login: "lee", name: "Lee Park" });
  const ava = fake.addPerson({ login: "ava", name: "Ava Reyes" });
  const acme = fake.addWorkspace({
    login: "acme",
    name: "Acme",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }, { name: "app" }],
  });
  fake.addWorkspace({ login: "sam", kind: "personal", members: { [sam.id]: "admin" } });
  const leeAccount = fake.addWorkspace({
    login: "lee",
    kind: "personal",
    members: { [lee.id]: "admin" },
    installed: false,
  });
  fake.addWorkspace({ login: "ava", kind: "personal", members: { [ava.id]: "admin" } });
  for (const person of [maya, sam, ava]) fake.finishStep(person.id, "where");
  for (const person of [maya, sam]) fake.claude.connect(person.id);
  const { api } = fake.connect(maya);
  const [site, app] = acme.repos;
  const ready = (async () => {
    const pricing = await api.canvases.create({
      workspaceId: acme.id,
      repoId: site!.id,
      name: "Pricing page",
    });
    await api.canvases.create({ workspaceId: acme.id, repoId: app!.id, name: "Onboarding" });
    await api.canvases.create({ workspaceId: acme.id, repoId: null, name: "Launch poster" });
    // Something to look at: the pricing canvas has two boards, as the agent drew them.
    const page = fake.canvas(pricing.id).sequencer.doc.pages[0]!.id;
    fake.agent(pricing.id).commit([
      { op: "artboard.create", page, index: 0, artboard: fakeBoard("ab_plans", "Plans", 0) },
      { op: "artboard.create", page, index: 1, artboard: fakeBoard("ab_faq", "FAQ", 480) },
    ]);
  })();
  return { fake, maya, sam, lee, ava, acme, leeAccount, ready };
}

/** The second workspace `stockCanvases` puts Maya in. */
export const NORTH = { login: "north", name: "Northbrook", canvas: "Brand refresh" } as const;

/**
 * Acme's canvases in each state the list draws, once the world is ready: Pricing page asks Maya
 * which blue (needs you, and has a preview), Onboarding is being drawn (working), Launch poster
 * is settled; and Maya is also in Northbrook, with one canvas of its own.
 */
export async function stockCanvases(world: FakeWorld): Promise<void> {
  await world.ready;
  const { fake, maya } = world;
  const named = (name: string) =>
    [...fake.canvases.values()].find(
      (c) => c.workspaceId === world.acme.id && c.sequencer.doc.name === name,
    );
  const pricing = named("Pricing page");
  const onboarding = named("Onboarding");
  const poster = named("Launch poster");
  if (pricing) {
    fake.agent(pricing.id).preview();
    fake.agent(pricing.id).ask(
      {
        kind: "question",
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
      },
      "Button colour",
    );
  }
  if (onboarding) fake.agent(onboarding.id).work([], "Drawing the welcome");
  const { api } = fake.connect(maya);
  if (poster) await api.canvases.settle(poster.id, true);
  const north = fake.addWorkspace({
    login: NORTH.login,
    name: NORTH.name,
    members: { [maya.id]: "member" },
    repos: [{ name: "brand" }],
  });
  await api.canvases.create({
    workspaceId: north.id,
    repoId: north.repos[0]!.id,
    name: NORTH.canvas,
  });
}

export interface FakeCloud extends Backend {
  kind: "fake";
  /** The world now (`reset` makes a new one). */
  readonly world: FakeWorld;
  seed(scenario: string): boolean;
  /** A new world, with nobody signed in: each test file's tests start from the same one. */
  reset(): void;
  /**
   * How GitHub's install page ends while the app asks the API about it: with `result` (the
   * account being set up is installed, for `installed`), or, with null, still waiting.
   */
  settleInstalls(result: string | null): void;
  /** The install pages the app opened, in turn. */
  readonly installPages: string[];
  /**
   * The person's Claude plan is at a limit until `until` (an ISO time), as a runner on it would
   * have seen, or no longer with null: `GET /v1/me` says so.
   */
  limitClaude(until: string | null): void;
}

/** The fake's install page: GitHub's, or the local stand-in the Maestro run serves. */
export function installPageFor(authorizeUrl: string | null): string {
  if (!authorizeUrl) return "https://github.com/apps/ponzu-dev/installations/new?state=fake";
  return new URL("/install", authorizeUrl).toString();
}

/** A whole fake Ponzu Cloud behind the app's `Backend`. */
export function fakeCloud(opts: { authorizeUrl?: string | null } = {}): FakeCloud {
  const authorizeUrl = opts.authorizeUrl ?? null;
  let world = fakeWorld();
  const session = new FakeSignInSession(world.maya);
  const clients = new Map<string, FakeClient>();
  let settled: string | null = null;
  let limitedUntil: string | null = null;
  const installPages: string[] = [];
  const stocked = new WeakSet<FakeWorld>();
  const client = () => {
    const person = session.person;
    let known = clients.get(person.id);
    if (!known) {
      known = world.fake.connect(person);
      clients.set(person.id, known);
    }
    return known;
  };
  /** The client's fake GitHub, with the install page's ending played by the test. */
  const github = (real: Api["github"]): Api["github"] => ({
    ...real,
    installLink: async (body) => {
      const answer = await real.installLink(body);
      const url = installPageFor(authorizeUrl);
      installPages.push(url);
      return { ...answer, url };
    },
    install: async (id) => {
      if (settled === null) return real.install(id);
      const person = session.person;
      const installing = [...world.fake.workspaces.values()].find(
        (workspace) => workspace.installing && workspace.members.has(person.id),
      );
      if (settled === "installed" && installing) world.fake.install(installing.id);
      return {
        status: "settled" as const,
        result: settled as "installed",
        workspaceId: settled === "installed" && installing ? installing.id : null,
      };
    },
  });
  /** `me`, with the plan's limit the test set (the client's fake has no runner to see one). */
  const me =
    (real: Api["me"]): Api["me"] =>
    async () => {
      const answer = await real();
      return answer.claudeAccount && limitedUntil
        ? { ...answer, claudeAccount: { ...answer.claudeAccount, limitedUntil } }
        : answer;
    };
  // The person signed in now: their api, whichever of them that is.
  const api = new Proxy({} as Api, {
    get: (_target, key) => {
      const real = client().api;
      if (key === "github") return github(real.github);
      if (key === "me") return me(real.me);
      return real[key as keyof Api];
    },
  });
  return {
    kind: "fake",
    get world() {
      return world;
    },
    session,
    api,
    makeLive: (): Live => world.fake.connect(session.person).live,
    authorizeUrl,
    prepare: () => world.ready,
    installId: async () => "0123456789abcdef0123456789abcdef",
    installPages,
    settleInstalls(result) {
      settled = result;
    },
    limitClaude(until) {
      limitedUntil = until;
    },
    reset() {
      world = fakeWorld();
      clients.clear();
      settled = null;
      limitedUntil = null;
      installPages.length = 0;
      session.person = world.maya;
      session.set({ status: "signed_out" });
    },
    seed(name) {
      if (!isScenario(name)) return false;
      const scenario: Scenario = name;
      const people: Partial<Record<Scenario, Profile>> = {
        empty: world.sam,
        "setup-where": world.lee,
        "setup-claude": world.ava,
      };
      session.person = people[scenario] ?? world.maya;
      const signedIn: SessionState = { status: "signed_in", user: session.person };
      const states: Record<Scenario, SessionState> = {
        "signed-out": { status: "signed_out" },
        "signed-in": signedIn,
        empty: signedIn,
        "github-reauth": { status: "github_reauth" },
        "too-old": { status: "too_old", minimumVersion: "1.0.0" },
        "setup-where": signedIn,
        "setup-claude": signedIn,
        canvases: signedIn,
      };
      // The rows change under the list as the live query would deliver them.
      if (scenario === "canvases" && !stocked.has(world)) {
        stocked.add(world);
        void stockCanvases(world);
      }
      session.set(states[scenario]);
      return true;
    },
  };
}

export const backend: FakeCloud = fakeCloud({
  // Spelled out: Metro inlines only `process.env.EXPO_PUBLIC_*` read by name.
  authorizeUrl: process.env.EXPO_PUBLIC_PONZU_FAKE_AUTHORIZE_URL || null,
});
