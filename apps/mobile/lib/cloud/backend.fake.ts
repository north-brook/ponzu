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
  /**
   * Maya's Pricing page with a thread (`stockChat`): her ask, Ponzu's reply with a link to the
   * Plans board, and a second turn still running, an aside on its way.
   */
  "chat",
  /**
   * Maya's Pricing page waiting on her (`stockAsks`): two questions in one ask (the second
   * multi-select), a plan to approve, and a permission, four pages in all.
   */
  "needs-you",
  /**
   * Maya's Pricing page with its pull request ready to merge (`stockPullRequest`): checks
   * passed, Theo approved, two comments, three files.
   */
  "pull-request",
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

/** What `stockChat` puts in the Pricing page's thread, for tests to look for. */
export const CHAT_SCENE = {
  ask: "Make the plans easier to compare",
  reply: (canvasId: string) =>
    `I put the **three plans** side by side, cheapest first. See [the Plans board](https://ponzu.design/canvases/${canvasId}?artboard=ab_plans).`,
  replyText: "I put the three plans side by side, cheapest first. See the Plans board.",
  again: "Now a dark version",
  aside: "Starting on the dark one.",
  working: "Drawing the dark plans",
} as const;

/**
 * The Pricing page's thread once the world is ready: Maya asked, Ponzu answered with a link to
 * the Plans board, Maya asked again, and that turn is running: an aside said, its work going on.
 */
export async function stockChat(world: FakeWorld): Promise<void> {
  await world.ready;
  const { fake, maya } = world;
  const pricing = [...fake.canvases.values()].find(
    (c) => c.workspaceId === world.acme.id && c.sequencer.doc.name === "Pricing page",
  );
  if (!pricing) return;
  const { api } = fake.connect(maya);
  const agent = fake.agent(pricing.id);
  await api.canvases.sendMessage(pricing.id, { text: CHAT_SCENE.ask });
  agent.say(CHAT_SCENE.reply(pricing.id));
  await api.canvases.sendMessage(pricing.id, { text: CHAT_SCENE.again });
  agent.work(["ab_plans"], CHAT_SCENE.working);
  agent.say(CHAT_SCENE.aside);
  agent.tool("Edited Plans", { streaming: true, artboards: ["ab_plans"] });
}

/** What `stockAsks` asks on the Pricing page, for tests to look for. */
export const ASKS_SCENE = {
  blue: {
    header: "Button colour",
    question: "Which blue for the buttons?",
    options: ["Royal", "Sky"],
  },
  sections: {
    header: "Sections",
    question: "Which sections go under the plans?",
    options: ["FAQ", "Testimonials", "Comparison table"],
  },
  planFirst: "Put the three plans side by side, cheapest first.",
  planRest: "Then add a short FAQ under them, and a dark version of both.",
  permission: { tool: "Bash", title: "Run the visual tests", description: "bun test visual" },
} as const;

/** The Pricing page waiting on Maya: a two-question ask, a plan and a permission. */
export async function stockAsks(world: FakeWorld): Promise<string[]> {
  await world.ready;
  const pricing = [...world.fake.canvases.values()].find(
    (c) => c.workspaceId === world.acme.id && c.sequencer.doc.name === "Pricing page",
  );
  if (!pricing) return [];
  const agent = world.fake.agent(pricing.id);
  const { blue, sections, planFirst, planRest, permission } = ASKS_SCENE;
  const asked = (q: typeof blue | typeof sections, multiSelect: boolean) => ({
    header: q.header,
    question: q.question,
    options: q.options.map((label) => ({ label, description: "" })),
    multiSelect,
  });
  return [
    agent.ask(
      { kind: "question", payload: { questions: [asked(blue, false), asked(sections, true)] } },
      blue.header,
    ),
    agent.ask({ kind: "plan", payload: { plan: `${planFirst}\n\n${planRest}` } }, "Plan"),
    agent.ask({ kind: "permission", payload: { ...permission } }, permission.title),
  ];
}

/** What `stockPullRequest` puts on the Pricing page's pull request, for tests to look for. */
export const PR_SCENE = {
  description: "Puts the three plans side by side, cheapest first, with a short FAQ under them.",
  checks: ["ci / test", "ci / lint", "ci / visual"],
  reviewer: "theo",
  comments: [
    { login: "theo", body: "The FAQ could be shorter." },
    { login: "maya", body: "Cut it to four questions." },
  ],
  files: [
    {
      path: "src/components/plans.tsx",
      additions: 3,
      deletions: 1,
      patch: [
        "@@ -1,4 +1,6 @@",
        " export function Plans() {",
        '-  return <Plan name="Pro" />;',
        "+  return (",
        '+    <PlanRow plans={["Free", "Pro", "Team"]} />',
        "+  );",
        " }",
      ].join("\n"),
    },
    {
      path: "src/app/pricing/page.tsx",
      additions: 2,
      deletions: 0,
      patch: "@@ -8,3 +8,5 @@\n <main>\n+  <Plans />\n+  <Faq />\n </main>",
    },
    { path: "public/plans.png", additions: 0, deletions: 0, patch: null },
  ],
} as const;

/**
 * The Pricing page's pull request once the world is ready: the agent pushed three files and kept
 * its words on them, Maya opened it and marked it ready, its checks passed, Theo approved and
 * two comments were left. Nothing stands in the way of Merge. The number is the fake's next.
 */
export async function stockPullRequest(world: FakeWorld): Promise<void> {
  await world.ready;
  const { fake, maya } = world;
  const pricing = [...fake.canvases.values()].find(
    (c) => c.workspaceId === world.acme.id && c.sequencer.doc.name === "Pricing page",
  );
  if (!pricing?.github) return;
  const { api } = fake.connect(maya);
  const github = pricing.github;
  fake.agent(pricing.id).push(PR_SCENE.files.map((file) => ({ ...file, change: "modified" })));
  github.describe(PR_SCENE.description);
  await api.canvases.pullRequest.open(pricing.id);
  await api.canvases.pullRequest.ready(pricing.id);
  github.setChecks(PR_SCENE.checks.map((name) => ({ name, state: "passed" })));
  github.review(PR_SCENE.reviewer, "approved");
  for (const { login, body } of PR_SCENE.comments) github.comment(login, body);
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
  const chatted = new WeakSet<FakeWorld>();
  const asked = new WeakSet<FakeWorld>();
  const pulled = new WeakSet<FakeWorld>();
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
        chat: signedIn,
        "needs-you": signedIn,
        "pull-request": signedIn,
      };
      // The rows change under the list as the live query would deliver them.
      // Maya is signed in once Northbrook exists, as someone already in two workspaces is: `me`
      // read before it would list one, and nothing tells the app to read it again.
      if (scenario === "canvases" && !stocked.has(world)) {
        stocked.add(world);
        const current = world;
        session.set({ status: "loading" });
        void stockCanvases(current).finally(() => {
          if (world === current) session.set(states[scenario]);
        });
        return true;
      }
      if (scenario === "chat" && !chatted.has(world)) {
        chatted.add(world);
        const current = world;
        session.set({ status: "loading" });
        void stockChat(current).finally(() => {
          if (world === current) session.set(states[scenario]);
        });
        return true;
      }
      if (scenario === "needs-you" && !asked.has(world)) {
        asked.add(world);
        const current = world;
        session.set({ status: "loading" });
        void stockAsks(current).finally(() => {
          if (world === current) session.set(states[scenario]);
        });
        return true;
      }
      if (scenario === "pull-request" && !pulled.has(world)) {
        pulled.add(world);
        const current = world;
        session.set({ status: "loading" });
        void stockPullRequest(current).finally(() => {
          if (world === current) session.set(states[scenario]);
        });
        return true;
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
