import { getWorkspace, grantAllowances, readWorkspaceUsage, setMonthlyCap } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { UserActor } from "../auth/actor.ts";
import { requireWorkspace } from "../auth/authorize.ts";
import { refreshWorkspaceRepoAccess } from "../auth/repo-access.ts";
import { billingPeriod } from "../billing/period.ts";
import { ungranted, type WorkspaceUsage, workspaceUsage } from "../billing/usage.ts";
import type { Deps } from "../deps/index.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import type { Logger } from "../http/log.ts";
import { validate } from "../http/validate.ts";

/*
 * Settings › Plan and usage (docs/cloud.md, "Billing"): a workspace's usage this billing period
 * in credits and cents, worked out from its usage events and the rate card, and its monthly
 * cap. There is no Stripe yet: the card and invoices answer `not_set_up`, nothing is billed,
 * and the cap is stored for when billing enforces it. Every member sees the totals and the
 * cap; an admin also sees who used what, and changes the cap.
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
  /** This period's allowance: the rate card's free credits for each person counted, pooled. */
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
  /** Billing is not built: no card, no invoices. The apps show the no-card state. */
  billing: z.object({
    status: z.literal("not_set_up"),
    card: z.null(),
    invoices: z.literal("not_set_up"),
  }),
  /** May change the cap: an admin. Everyone else gets this view read-only. */
  canManage: z.boolean(),
  mine: PersonUsage,
  /** Everyone's use this period, highest first. Admins only; null for anyone else. */
  byPerson: z.array(PersonUsage).nullable(),
  /** Use put down to nobody (a deleted account). Admins only. */
  unattributedCredits: z.number().int().nullable(),
  /**
   * Use by design, highest first, then designs since deleted (`deleted`) and designs the admin
   * may not see by name (`hidden`), each as one line with no design. Shared out of the rounded
   * total, so it adds up to `usedCredits` exactly, as `byPerson` with `unattributedCredits` does.
   */
  byDesign: z
    .array(
      z.object({
        kind: z.enum(["design", "deleted", "hidden"]),
        design: z.object({ id: z.string(), name: z.string() }).nullable(),
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

/** The workspace's usage this period, as the viewer may see it. */
async function usageFor(c: UserContext, workspaceId: string): Promise<WorkspaceUsage> {
  const { deps, actor } = c.var;
  const member = await requireWorkspace(c, workspaceId);
  const workspace = await getWorkspace(deps.db, member.id);
  if (!workspace) throw new ApiError(404, "not_found", "There is no such workspace.");
  const now = new Date(deps.clock.now());
  const period = billingPeriod(workspace.billingPeriodAnchor, now);
  // An admin's breakdown names designs by the repos they can read, as of the last minute.
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
  return workspaceUsage(read, period, { user: actor.user, member });
}

const view = (usage: WorkspaceUsage) =>
  Usage.parse({
    ...usage,
    billing: { status: "not_set_up", card: null, invoices: "not_set_up" },
  });

export const usage = new Hono<AppEnv>()
  /** This billing period so far. */
  .get("/workspaces/:id/usage", access.user, validate("param", WorkspaceParam), async (c) =>
    c.json(view(await usageFor(c, c.req.valid("param").id))),
  )

  /**
   * Set the monthly cap, in whole dollars: admins only, and never below what the period has
   * billed. Stored for billing to enforce; nothing is refused for it yet.
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
      const current = await usageFor(c, workspace.id);
      if (capUsd < current.cap.lowestUsd) {
        throw new ApiError(
          400,
          "cap_too_low",
          `The cap can't be below $${current.cap.lowestUsd}, which this month has billed.`,
          { details: { lowestUsd: current.cap.lowestUsd } },
        );
      }
      await setMonthlyCap(c.var.deps.db, { workspaceId: workspace.id, capCents: capUsd * 100 });
      c.var.log.info("monthly_cap_set", { workspaceId: workspace.id, capUsd });
      return c.json(view(await usageFor(c, workspace.id)));
    },
  );
