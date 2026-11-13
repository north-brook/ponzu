import {
  BILLING_GATES,
  getWorkspace,
  grantAllowances,
  PAST_DUE_REASONS,
  readWorkspaceUsage,
  setMonthlyCap,
  type Workspace,
  type WorkspaceUsageRead,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { UserActor } from "../auth/actor.ts";
import { requireWorkspace } from "../auth/authorize.ts";
import { refreshWorkspaceRepoAccess } from "../auth/repo-access.ts";
import { capWarning } from "../billing/credits.ts";
import { billingPeriod } from "../billing/period.ts";
import { refreshBillingGate } from "../billing/refresh.ts";
import { ungranted, type WorkspaceUsage, workspaceUsage } from "../billing/usage.ts";
import type { Deps } from "../deps/index.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../http/log.ts";
import { validate } from "../http/validate.ts";

/*
 * Settings › Plan and usage (docs/cloud.md, "Billing"): a workspace's usage this billing period
 * in credits and cents, worked out from its usage events and the rate card, and its monthly
 * cap. Every member sees the totals and the cap; an admin also sees who used what, and changes
 * the cap.
 *
 * While PONZU_BILLING is off, `billing` answers exactly as it did before billing was built
 * (`not_set_up`, no card, no invoices). In observe it still says `not_set_up`, so an app that
 * predates billing shows nothing as billed, and adds the cached gate and the cap warning. When
 * billing is on it says `on`, with the card and what is past due for an admin.
 */

const PersonUsage = z.object({
  person: z.object({
    id: z.string(),
    name: z.string(),
    login: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  admin: z.boolean(),
  usedCredits: z.number().int(),
});

const Usage = z.object({
  period: z.object({ start: z.date(), end: z.date() }),
  /** What one credit sells for, in cents. */
  creditCents: z.number().int(),
  usedCredits: z.number().int(),
  /**
   * This period's allowance: the rate card's free credits for each person counted, pooled, plus
   * support's adjustments, never below zero.
   */
  freeCredits: z.number().int(),
  /** Used past the free credits: what would be billed. */
  billedCredits: z.number().int(),
  billedCents: z.number().int(),
  /** The people the free credits are counted for. */
  people: z.number().int(),
  cap: z.object({
    /** On what is billed in a period, in whole dollars. */
    usd: z.number().int(),
    /** None was set: this is the rate card's default. */
    isDefault: z.boolean(),
    /** The least it may be set to now. */
    lowestUsd: z.number().int(),
  }),
  /**
   * Whether Ponzu bills the workspace. `not_set_up` (billing off or observing): no card, no
   * invoices, nothing billed, and the apps show the no-card state. `on`: billed past the free
   * credits, up to the cap. `invoices` stays `not_set_up` (they live in Stripe's portal) for the
   * apps that read it. `gate`, `capWarning` and `pastDue` are there only while billing is not off.
   */
  billing: z.object({
    status: z.enum(["not_set_up", "on"]),
    /** The card Stripe charges: an admin's view only, else null. */
    card: z.object({ brand: z.string(), last4: z.string().nullable() }).nullable(),
    invoices: z.literal("not_set_up"),
    /** The cached gate the routes, wakes and claims read (`ok` when nothing is held back). */
    gate: z.enum(BILLING_GATES).optional(),
    /** Billed has reached the warning share of the cap, with a card. */
    capWarning: z.boolean().optional(),
    /** An invoice that is not paid: an admin's view only, else null. */
    pastDue: z
      .object({
        since: z.date(),
        reason: z.enum(PAST_DUE_REASONS),
        invoiceUrl: z.string().nullable(),
      })
      .nullable()
      .optional(),
  }),
  /** May change the cap: an admin. Everyone else gets this view read-only. */
  canManage: z.boolean(),
  mine: PersonUsage,
  /** Everyone's use this period, highest first. Admins only; null for anyone else. */
  byPerson: z.array(PersonUsage).nullable(),
  /** Use put down to nobody (a deleted account). Admins only. */
  unattributedCredits: z.number().int().nullable(),
  /**
   * Use by canvas, highest first, then canvases since deleted (`deleted`) and canvases the admin
   * may not see by name (`hidden`), each as one line with no canvas. Shared out of the rounded
   * total, so it adds up to `usedCredits` exactly, as `byPerson` with `unattributedCredits` does.
   */
  byCanvas: z
    .array(
      z.object({
        kind: z.enum(["canvas", "deleted", "hidden"]),
        canvas: z.object({ id: z.string(), name: z.string() }).nullable(),
        usedCredits: z.number().int(),
      }),
    )
    .nullable(),
});

const WorkspaceParam = z.object({ id: z.string().min(1).max(64) });
/** Whole dollars. The upper bound keeps cents inside a Postgres integer. */
const CapBody = z.object({ capUsd: z.number().int().min(1).max(1_000_000) });

/** A handler's context, as far as these need it. */
type UserContext = { var: { deps: Deps; log: Logger; actor: UserActor } };

/** What a usage read worked from, beside the usage itself. */
interface UsageRead {
  usage: WorkspaceUsage;
  workspace: Workspace;
  read: WorkspaceUsageRead;
}

/** The workspace's usage this period, as the viewer may see it. */
async function usageFor(c: UserContext, workspaceId: string): Promise<UsageRead> {
  const { deps, actor } = c.var;
  const member = await requireWorkspace(c, workspaceId);
  const workspace = await getWorkspace(deps.db, member.id);
  if (!workspace) throw new ApiError(404, "not_found", "There is no such workspace.");
  const now = new Date(deps.clock.now());
  const period = billingPeriod(workspace.billingPeriodAnchor, now);
  // An admin's breakdown names canvases by the repos they can read, as of the last minute.
  if (member.role === "admin") {
    await refreshWorkspaceRepoAccess(
      { ...deps, log: c.var.log },
      { user: actor.user, workspace: member },
    );
  }
  const read = await readWorkspaceUsage(deps.db, {
    workspaceId: member.id,
    viewerId: actor.user.id,
    start: period.start,
    end: period.end,
    now,
  });
  if (!read) throw new ApiError(404, "not_found", "There is no such workspace.");
  // A member's allowance is granted the first time the period is read with them in it, so a
  // member who leaves later in the period stays counted (`countedPeople`).
  await grantAllowances(deps.db, {
    workspaceId: member.id,
    periodStart: period.start,
    now,
    userIds: ungranted(read),
  });
  return { usage: workspaceUsage(read, period, { user: actor.user, member }), workspace, read };
}

/** `billing` as the mode says it (see the top of this file). */
function billingView(deps: Deps, { usage, workspace, read }: UsageRead) {
  const off = { status: "not_set_up" as const, card: null, invoices: "not_set_up" as const };
  const mode = deps.features.billing;
  if (mode === "off") return off;
  const admin = usage.canManage;
  const hasCard = workspace.stripePaymentMethodId !== null;
  const capCents = read.monthlyCapCents ?? read.current.defaultCapCents;
  const extra = {
    gate: workspace.billingGate,
    capWarning: hasCard && capWarning(usage.billedCents, capCents, read.current.capWarningFraction),
  };
  if (mode === "observe") return { ...off, ...extra, pastDue: null };
  return {
    status: "on" as const,
    card:
      admin && hasCard
        ? { brand: workspace.cardBrand ?? "other", last4: workspace.cardLast4 }
        : null,
    invoices: "not_set_up" as const,
    ...extra,
    pastDue:
      admin && workspace.pastDueAt
        ? {
            since: workspace.pastDueAt,
            reason: workspace.pastDueReason ?? "failed",
            invoiceUrl: workspace.pastDueInvoiceUrl,
          }
        : null,
  };
}

const view = (deps: Deps, read: UsageRead) =>
  Usage.parse({ ...read.usage, billing: billingView(deps, read) });

export const usage = new Hono<AppEnv>()
  /** This billing period so far. */
  .get("/workspaces/:id/usage", access.user, validate("param", WorkspaceParam), async (c) =>
    c.json(view(c.var.deps, await usageFor(c, c.req.valid("param").id))),
  )

  /**
   * Set the monthly cap, in whole dollars: admins only, and never below what the period has
   * billed. While billing is not off, the gate is worked out again at once, so a raised cap lets
   * held canvases go (`refreshBillingGate` wakes them).
   */
  .patch(
    "/workspaces/:id/billing",
    access.user,
    validate("param", WorkspaceParam),
    validate("json", CapBody),
    async (c) => {
      const { id } = c.req.valid("param");
      const workspace = await requireWorkspace(c, id, "admin");
      const { capUsd } = c.req.valid("json");
      const { usage: current } = await usageFor(c, workspace.id);
      if (capUsd < current.cap.lowestUsd) {
        throw new ApiError(
          400,
          "cap_too_low",
          `The cap can't be below $${current.cap.lowestUsd}, which this month has billed.`,
          { details: { lowestUsd: current.cap.lowestUsd } },
        );
      }
      const { deps } = c.var;
      await setMonthlyCap(deps.db, { workspaceId: workspace.id, capCents: capUsd * 100 });
      c.var.log.info("monthly_cap_set", { workspaceId: workspace.id, capUsd });
      deps.analytics.capture("monthly cap set", { cap_usd: capUsd });
      // Nothing while billing is off.
      await refreshBillingGate({ ...deps, log: c.var.log }, workspace.id);
      return c.json(view(deps, await usageFor(c, workspace.id)));
    },
  );
