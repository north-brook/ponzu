import { describe, expect, test } from "bun:test";
import {
  canContinue,
  type GithubAccount,
  isReady,
  type SetupFacts,
  type SetupStep,
  setupProgress,
  setupStep,
} from "./setup.ts";

const ready = { installed: true, suspended: false };
const suspended = { installed: true, suspended: true };
const removed = { installed: false, suspended: false };

const brandNew: SetupFacts = {
  signedIn: true,
  workspaces: [],
  whereConfirmed: false,
  claude: null,
  iphoneStepSeen: false,
  hasIphone: false,
};

describe("the gates, as people meet them", () => {
  test("a brand-new person on the Mac goes through every step in order", () => {
    const steps: SetupStep[] = [];
    let facts: SetupFacts = { ...brandNew, signedIn: false };
    const visit = (next: Partial<SetupFacts>) => {
      steps.push(setupStep(facts));
      facts = { ...facts, ...next };
    };
    visit({ signedIn: true });
    visit({ workspaces: [ready] });
    // Setting an account up is not enough: Continue is what confirms the step.
    visit({ whereConfirmed: true });
    visit({ claude: { status: "connected" } });
    visit({ iphoneStepSeen: true });
    steps.push(setupStep(facts));
    expect(steps).toEqual(["sign_in", "where", "where", "claude", "iphone", "done"]);
  });

  test("a teammate whose organization is already set up still sees where they design once", () => {
    expect(setupStep({ ...brandNew, workspaces: [ready] })).toBe("where");
  });

  test("someone who set up on the iPhone first lands straight on the app on the Mac", () => {
    const fromPhone = {
      ...brandNew,
      workspaces: [ready],
      whereConfirmed: true,
      claude: { status: "connected" as const },
      hasIphone: true,
    };
    expect(setupStep(fromPhone)).toBe("done");
  });

  test("losing every installation sends a returning person back to where they design", () => {
    const returning: SetupFacts = {
      ...brandNew,
      workspaces: [removed, suspended],
      whereConfirmed: true,
      claude: { status: "connected" },
      iphoneStepSeen: true,
    };
    expect(setupStep(returning)).toBe("where");
  });

  test("a Claude that signed out later asks on send, not through setup again", () => {
    for (const status of ["expired", "revoked"] as const) {
      const returning = {
        ...brandNew,
        workspaces: [ready],
        whereConfirmed: true,
        claude: { status },
        iphoneStepSeen: true,
      };
      expect(setupStep(returning)).toBe("done");
    }
  });
});

describe("the gates, every combination", () => {
  const bools = [false, true];
  const workspaceSets = [[], [ready], [suspended], [removed], [removed, ready]];
  const claudes = [null, { status: "connected" as const }, { status: "revoked" as const }];
  const all: SetupFacts[] = [];
  for (const signedIn of bools)
    for (const workspaces of workspaceSets)
      for (const whereConfirmed of bools)
        for (const claude of claudes)
          for (const iphoneStepSeen of bools)
            for (const hasIphone of bools)
              all.push({ signedIn, workspaces, whereConfirmed, claude, iphoneStepSeen, hasIphone });

  // Each gate, as its own predicate: true when it holds the person back.
  const gates: [SetupStep, (f: SetupFacts) => boolean][] = [
    ["sign_in", (f) => !f.signedIn],
    ["where", (f) => !f.whereConfirmed || !f.workspaces.some((w) => w.installed && !w.suspended)],
    ["claude", (f) => f.claude === null],
    ["iphone", (f) => !f.iphoneStepSeen && !f.hasIphone],
  ];

  test(`the step is the first gate that holds, in all ${all.length}`, () => {
    for (const facts of all) {
      const expected = gates.find(([, holds]) => holds(facts))?.[0] ?? "done";
      expect({ facts, step: setupStep(facts) }).toEqual({ facts, step: expected });
    }
  });
});

describe("where do you design", () => {
  const account = (over: Partial<GithubAccount>): GithubAccount => ({
    githubAccountId: 1,
    login: "brycedbjork",
    name: "Bryce Bjork",
    avatarUrl: null,
    kind: "personal",
    status: "not_installed",
    workspaceId: null,
    suspended: false,
    memberCount: null,
    ...over,
  });

  test("Continue waits for an account that is installed and not suspended", () => {
    expect(canContinue([account({})])).toBe(false);
    expect(canContinue([account({ status: "ready", suspended: true })])).toBe(false);
    expect(canContinue([account({}), account({ status: "ready", kind: "org" })])).toBe(true);
    expect(isReady(account({ status: "ready" }))).toBe(true);
  });

  test("progress fills to the step's place", () => {
    expect([setupProgress("where"), setupProgress("claude"), setupProgress("iphone")]).toEqual([
      1, 2, 3,
    ]);
  });
});
