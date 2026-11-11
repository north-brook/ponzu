import { expect, test } from "bun:test";
import { createFakeBackend } from "@ponzu/client/testing";
import { claudeReady, nameFor, newCreateKey } from "./create.tsx";

test("a new design is called by the first line of what it was asked, until the agent names it", () => {
  expect(nameFor("  A pricing page\nwith three plans")).toBe("A pricing page");
  expect(nameFor("x".repeat(60))).toBe(`${"x".repeat(47)}…`);
});

test("a create key is one the API takes", () => {
  expect(newCreateKey()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(newCreateKey()).not.toBe(newCreateKey());
});

test("a send goes only on a connected Claude; none, or one signed out, asks first", () => {
  expect(claudeReady(undefined)).toBe(false);
  expect(claudeReady({ claudeAccount: null })).toBe(false);
  const account = {
    kind: "subscription" as const,
    label: "Claude Max",
    email: null,
    connectedAt: "2026-11-01T00:00:00.000Z",
    expiresAt: null,
    expiresSoon: false,
    limitedUntil: null,
  };
  expect(claudeReady({ claudeAccount: { ...account, status: "expired" } })).toBe(false);
  expect(claudeReady({ claudeAccount: { ...account, status: "connected" } })).toBe(true);
});

test("pressing send twice makes one design, with its first message and what it runs on", async () => {
  const backend = createFakeBackend();
  const maya = backend.addPerson({ login: "maya" });
  const ws = backend.addWorkspace({
    login: "north-brook",
    members: { [maya.id]: "admin" },
    repos: [{ name: "site" }],
  });
  const { api } = backend.connect(maya);
  const body = {
    workspaceId: ws.id,
    repoId: ws.repos[0]!.id,
    name: "One-page checkout",
    message: { text: "Make checkout one page" },
    model: "claude-sonnet-5-5",
    effort: "low" as const,
    createKey: newCreateKey(),
  };
  const [first, second] = await Promise.all([api.designs.create(body), api.designs.create(body)]);
  expect(second.id).toBe(first.id);
  const made = [...backend.designs.values()];
  expect(made.map((d) => [d.model, d.effort, d.thread.length])).toEqual([
    ["claude-sonnet-5-5", "low", 1],
  ]);
  // The next composition is a new design.
  const next = await api.designs.create({ ...body, createKey: newCreateKey() });
  expect(next.id).not.toBe(first.id);
});
