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
  /** Maya's acme workspace. */
  acme: { id: string; repos: { id: string; fullName: string }[] };
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

/** Maya in acme with three canvases (the first with two boards), and Sam alone with none. */
export function fakeWorld(fake: FakeBackend = createFakeBackend()): FakeWorld {
  const maya = fake.addPerson({ login: "maya", name: "Maya Lin" });
  const sam = fake.addPerson({ login: "sam", name: "Sam Ortiz" });
  const acme = fake.addWorkspace({
    login: "acme",
    name: "Acme",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }, { name: "app" }],
  });
  fake.addWorkspace({ login: "sam", kind: "personal", members: { [sam.id]: "admin" } });
  fake.finishStep(maya.id, "where");
  fake.finishStep(sam.id, "where");
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
  return { fake, maya, sam, acme, ready };
}

export interface FakeCloud extends Backend {
  kind: "fake";
  world: FakeWorld;
  seed(scenario: string): boolean;
}

/** A whole fake Ponzu Cloud behind the app's `Backend`. */
export function fakeCloud(opts: { authorizeUrl?: string | null } = {}): FakeCloud {
  const world = fakeWorld();
  const session = new FakeSignInSession(world.maya);
  const clients = new Map<string, FakeClient>();
  const client = () => {
    const person = session.person;
    let known = clients.get(person.id);
    if (!known) {
      known = world.fake.connect(person);
      clients.set(person.id, known);
    }
    return known;
  };
  // The person signed in now: their api, whichever of them that is.
  const api = new Proxy({} as Api, {
    get: (_target, key) => client().api[key as keyof Api],
  });
  return {
    kind: "fake",
    world,
    session,
    api,
    makeLive: (): Live => world.fake.connect(session.person).live,
    authorizeUrl: opts.authorizeUrl ?? null,
    prepare: () => world.ready,
    installId: async () => "0123456789abcdef0123456789abcdef",
    seed(name) {
      if (!isScenario(name)) return false;
      const scenario: Scenario = name;
      session.person = scenario === "empty" ? world.sam : world.maya;
      const states: Record<Scenario, SessionState> = {
        "signed-out": { status: "signed_out" },
        "signed-in": { status: "signed_in", user: session.person },
        empty: { status: "signed_in", user: session.person },
        "github-reauth": { status: "github_reauth" },
        "too-old": { status: "too_old", minimumVersion: "1.0.0" },
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
