import { describe, expect, test } from "bun:test";
import { billingRequired, cardBrand, cardSetupError, pastDueWords } from "./billing.ts";
import { billingBlocker, blockerWords } from "./gate.ts";

const details = {
  reason: "free_used",
  workspaceId: "ws_1",
  workspaceName: "Northwind",
  canManage: true,
  capUsd: 100,
  billedCents: 0,
  periodEnd: "2026-12-09T00:00:00.000Z",
  invoiceUrl: null,
};

describe("the 402 billing_required", () => {
  test("is read from the API's error, details and all", () => {
    expect(
      billingRequired({ status: 402, code: "billing_required", message: "x", details }),
    ).toEqual({ ...details, reason: "free_used" });
    const pay = {
      ...details,
      reason: "payment_failed",
      invoiceUrl: "https://invoice.stripe.com/i/1",
    };
    expect(
      billingRequired({ status: 402, code: "billing_required", details: pay })?.invoiceUrl,
    ).toBe("https://invoice.stripe.com/i/1");
  });

  test("anything else is not the wall: another code, another status, or details it can't read", () => {
    expect(billingRequired(null)).toBeNull();
    expect(billingRequired(new Error("no"))).toBeNull();
    expect(billingRequired({ status: 409, code: "billing_not_set_up", details })).toBeNull();
    expect(billingRequired({ status: 402, code: "billing_required" })).toBeNull();
    expect(
      billingRequired({
        status: 402,
        code: "billing_required",
        details: { ...details, reason: "x" },
      }),
    ).toBeNull();
    expect(
      billingRequired({
        status: 402,
        code: "billing_required",
        details: { reason: "cap_reached" },
      }),
    ).toBeNull();
  });
});

test("the card row's words for what is past due", () => {
  expect(pastDueWords({ reason: "failed", invoiceUrl: null })).toBe("Payment failed");
  expect(pastDueWords({ reason: "needs_confirmation", invoiceUrl: null })).toBe(
    "Payment needs your confirmation",
  );
});

test("card brands: Visa, Mastercard and Amex have marks, the rest is a card", () => {
  expect(["visa", "mastercard", "amex", "discover", "link", ""].map(cardBrand)).toEqual([
    "visa",
    "mastercard",
    "amex",
    "other",
    "other",
    "other",
  ]);
});

test("what a card setup came to, in the dialog's words", () => {
  expect(cardSetupError("added", true)).toBeNull();
  expect(cardSetupError("cancelled", true)).toBe(
    "The card wasn't added. Your prompt is still here.",
  );
  expect(cardSetupError("failed", true)).toBe("The card wasn't added. Your prompt is still here.");
  expect(cardSetupError("cancelled", false)).toBe("The card wasn't added.");
  expect(cardSetupError("expired", true)).toBe("That took too long. Try again.");
  expect(cardSetupError("expired", false)).toBe("That took too long. Try again.");
});

describe("a head's billing blocker", () => {
  const workspace = { name: "Northwind", personal: false };
  const usage = { capUsd: 500, periodEnd: "2026-12-09T12:00:00.000Z" };

  test("gives the thread line, with the button only for whoever can act", () => {
    const admin = billingBlocker("credits_used_up", { workspace, canManage: true, usage });
    expect(admin && blockerWords(admin).action).toBe("Add a card");
    const member = billingBlocker("payment_failed", { workspace, canManage: false, usage });
    expect(member && blockerWords(member)).toEqual({
      line: "Northwind's last payment didn't go through. This canvas waits until it's paid.",
      phone: "Northwind's last payment didn't go through. This canvas waits.",
      action: null,
      queued: null,
    });
    const cap = billingBlocker("cap_reached", { workspace, canManage: true, usage });
    expect(cap).toEqual({ blocker: "cap_reached", workspace, canManage: true, ...usage });
  });

  test("is null for any other blocker, and for the cap until usage has answered", () => {
    for (const other of [null, undefined, "paused", "sandbox_busy", "claude_limited"]) {
      expect(billingBlocker(other, { workspace, canManage: true, usage })).toBeNull();
    }
    expect(billingBlocker("cap_reached", { workspace, canManage: true, usage: null })).toBeNull();
  });
});
