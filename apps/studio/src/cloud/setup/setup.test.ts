import { describe, expect, test } from "bun:test";
import {
  canContinue,
  claudeStepMode,
  type GithubAccount,
  isReady,
  type SetupFacts,
  type SetupStep,
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
  claudeSignIn: null,
  iphoneStepSeen: false,
  hasIphone: false,
};

const NOW = Date.parse("2026-11-10T12:00:00Z");
const minutes = (n: number) => new Date(NOW + n * 60_000).toISOString();
const pending = { expiresAt: minutes(6) };
const lapsed = { expiresAt: minutes(-1) };

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
    // One installation still standing among the lost ones is enough.
    expect(setupStep({ ...returning, workspaces: [removed, suspended, ready] })).toBe("done");
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

  test("someone who pressed Sign in and relaunched lands back on the code field", () => {
    const signingIn = { ...brandNew, workspaces: [ready], whereConfirmed: true };
    expect(setupStep({ ...signingIn, claudeSignIn: pending })).toBe("claude");
    expect(claudeStepMode({ ...signingIn, claudeSignIn: pending }, NOW)).toBe("subscription");
    // Ten minutes on, the sign-in has lapsed: back to the two ways.
    expect(claudeStepMode({ ...signingIn, claudeSignIn: lapsed }, NOW)).toBe("choose");
    expect(claudeStepMode(signingIn, NOW)).toBe("choose");
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
});
