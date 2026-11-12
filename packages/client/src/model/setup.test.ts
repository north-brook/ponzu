import { describe, expect, test } from "bun:test";
import {
  accountLabel,
  canContinue,
  claudeStepMode,
  type GithubAccount,
  installNotice,
  isReady,
  phoneSetupStep,
  type SetupFacts,
  type SetupStep,
  setupFacts,
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

  test("a teammate whose organization is already set up still sees where they build once", () => {
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

  test("losing every installation sends a returning person back to where they build", () => {
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

describe("where do you build", () => {
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

  test("each row's two lines, as the Mac and the phone both write them", () => {
    expect(accountLabel(account({}))).toEqual({ title: "Personal", line: "brycedbjork" });
    const org = account({ kind: "org", login: "acme", name: "Acme Inc", status: "ready" });
    expect(accountLabel({ ...org, memberCount: 1 })).toEqual({
      title: "Acme Inc",
      line: "acme · 1 person",
    });
    expect(accountLabel({ ...org, memberCount: 4 }).line).toBe("acme · 4 people");
    // An organization with no other name is its login, with only the people under it.
    expect(accountLabel({ ...org, name: "", memberCount: 4 })).toEqual({
      title: "acme",
      line: "4 people",
    });
    expect(accountLabel({ ...org, name: "acme", memberCount: null })).toEqual({
      title: "acme",
      line: null,
    });
  });

  test("only an install asked of the owners, or one that failed, leaves a line", () => {
    expect(installNotice("requested")).toBe("requested");
    expect(installNotice("failed")).toBe("failed");
    for (const result of ["installed", "pending", "sign_in", "cancelled"]) {
      expect(installNotice(result)).toBeNull();
    }
  });
});

describe("the phone's steps", () => {
  type Me = Parameters<typeof phoneSetupStep>[0];
  const me = (over: {
    workspaces?: { installed: boolean; suspended: boolean }[];
    where?: boolean;
    iphone?: boolean;
    claude?: "connected" | "expired" | null;
  }): Me =>
    ({
      workspaces: (over.workspaces ?? []).map((w, i) => ({ id: `ws_${i}`, ...w })),
      onboarding: {
        whereConfirmedAt: over.where ? "2026-11-10T00:00:00Z" : null,
        iphoneStepSeenAt: over.iphone ? "2026-11-10T00:00:00Z" : null,
      },
      claudeAccount: over.claude ? { status: over.claude } : null,
    }) as unknown as Me;

  test("where, then Claude, then done: the phone never asks for an iPhone", () => {
    expect(phoneSetupStep(me({}))).toBe("where");
    expect(phoneSetupStep(me({ workspaces: [ready] }))).toBe("where");
    expect(phoneSetupStep(me({ workspaces: [suspended], where: true }))).toBe("where");
    expect(phoneSetupStep(me({ workspaces: [removed], where: true }))).toBe("where");
    expect(phoneSetupStep(me({ workspaces: [ready], where: true }))).toBe("claude");
    expect(phoneSetupStep(me({ workspaces: [ready], where: true, claude: "connected" }))).toBe(
      "done",
    );
  });

  test("a Claude that has signed out sends no one back through setup; none at all does", () => {
    expect(phoneSetupStep(me({ workspaces: [ready], where: true, claude: "expired" }))).toBe(
      "done",
    );
    // Through setup on the Mac before (the iPhone step seen): disconnected is signed out.
    expect(phoneSetupStep(me({ workspaces: [ready], where: true, iphone: true }))).toBe("done");
    expect(setupFacts(me({ workspaces: [ready], where: true, iphone: true })).claude).toEqual({
      status: "revoked",
    });
  });
});
