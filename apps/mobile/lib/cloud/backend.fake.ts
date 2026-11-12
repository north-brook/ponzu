import {
  type Api,
  type Live,
  type Profile,
  type Session,
  type SessionState,
  SignInError,
} from "@ponzu/client";
import { createFakeBackend, type FakeBackend, type FakeClient } from "@ponzu/client/testing";
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

/**
 * Maya in acme with three canvases, and Sam alone with none, both through setup with Claude
 * connected; Lee and Ava part of the way through it.
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
    await api.canvases.create({ workspaceId: acme.id, repoId: site!.id, name: "Pricing page" });
    await api.canvases.create({ workspaceId: acme.id, repoId: app!.id, name: "Onboarding" });
    await api.canvases.create({ workspaceId: acme.id, repoId: null, name: "Launch poster" });
  })();
  return { fake, maya, sam, lee, ava, acme, leeAccount, ready };
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
  const installPages: string[] = [];
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
  // The person signed in now: their api, whichever of them that is.
  const api = new Proxy({} as Api, {
    get: (_target, key) => {
      const real = client().api;
      return key === "github" ? github(real.github) : real[key as keyof Api];
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
    reset() {
      world = fakeWorld();
      clients.clear();
      settled = null;
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
      };
      session.set(states[scenario]);
      return true;
    },
  };
}

export const backend: FakeCloud = fakeCloud({
  // Spelled out: Metro inlines only `process.env.EXPO_PUBLIC_*` read by name.
  authorizeUrl: process.env.EXPO_PUBLIC_PONZU_FAKE_AUTHORIZE_URL || null,
});
