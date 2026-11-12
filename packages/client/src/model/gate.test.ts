import { expect, test } from "bun:test";
import { blockerWords } from "./gate.ts";
import type { Person } from "./model.ts";
import { clock } from "./time.ts";

const maya: Person = { id: "usr_maya", name: "Maya Ortiz", login: "maya", avatarUrl: null };
const team = { name: "Northwind", personal: false };
const personal = { name: "maya", personal: true };
// Midday UTC, so the day is the same wherever the test runs.
const periodEnd = "2026-12-01T12:00:00Z";

test("wakes paused while Ponzu updates read as production's thread line", () => {
  expect(blockerWords({ blocker: "paused" })).toEqual({
    line: "The agent is paused while Ponzu updates. Your message is kept and goes through when it's back.",
    phone:
      "The agent is paused while Ponzu updates. Your message is kept and goes through when it's back.",
    action: null,
    queued: null,
  });
});

test("free credits used up: a team waits for a card, a person for their own", () => {
  expect(blockerWords({ blocker: "credits_used_up", workspace: team, canManage: true })).toEqual({
    line: "Northwind's free credits for this month are used up. This canvas waits until a card is added.",
    phone: "Northwind's free credits for this month are used up. This canvas waits.",
    action: "Add a card",
    queued: null,
  });
  expect(
    blockerWords({ blocker: "credits_used_up", workspace: personal, canManage: true }),
  ).toEqual({
    line: "Your free credits for this month are used up. This canvas waits until you add a card.",
    phone: "Your free credits for this month are used up. This canvas waits.",
    action: "Add a card",
    queued: null,
  });
  // A member who can't manage billing gets the line and no button.
  expect(
    blockerWords({ blocker: "credits_used_up", workspace: team, canManage: false }).action,
  ).toBeNull();
});

test("at the cap, the line names the cap and when it resets", () => {
  const words = blockerWords({
    blocker: "cap_reached",
    workspace: team,
    canManage: true,
    capUsd: 100,
    periodEnd,
  });
  expect(words).toEqual({
    line: "Northwind has reached this month's $100 cap. This canvas waits until the cap is raised or it resets on December 1.",
    phone: "Northwind has reached this month's $100 cap. This canvas waits until December 1.",
    action: "Raise cap",
    queued: null,
  });
});

test("a payment that didn't go through waits until it's paid", () => {
  expect(blockerWords({ blocker: "payment_failed", workspace: team, canManage: true })).toEqual({
    line: "Northwind's last payment didn't go through. This canvas waits until it's paid.",
    phone: "Northwind's last payment didn't go through. This canvas waits.",
    action: "Pay invoice",
    queued: null,
  });
  expect(
    blockerWords({ blocker: "payment_failed", workspace: team, canManage: false }).action,
  ).toBeNull();
});

test("a Claude plan at its limit says whose, until when, and that a message waits for it", () => {
  const until = "2026-11-12T16:00:00Z";
  const theirs = blockerWords({ blocker: "claude_limited", owner: maya, meId: "usr_ines", until });
  expect(theirs).toEqual({
    line: `Maya's plan is at its limit until ${clock(until)}. This canvas waits.`,
    phone: `Maya's plan is at its limit until ${clock(until)}. This canvas waits.`,
    action: null,
    queued: "Your message goes in when it resets.",
  });
  expect(blockerWords({ blocker: "claude_limited", owner: maya, meId: maya.id, until }).line).toBe(
    `Your plan is at its limit until ${clock(until)}. This canvas waits.`,
  );
});
