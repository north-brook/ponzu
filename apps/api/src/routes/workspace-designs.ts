import {
  AGENT_STATES,
  DESIGN_STATUSES,
  listWorkspaceDesigns,
  PR_CHECKS,
  PR_STATES,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { requireWorkspace } from "../auth/authorize.ts";
import { refreshWorkspaceRepoAccess } from "../auth/repo-access.ts";
import type { AppEnv } from "../http/context.ts";
import { validate } from "../http/validate.ts";

/** A row of the sidebar: what `workspace.designs` delivers live, plus how far the person has looked. */
const DesignRow = z.object({
  id: z.string(),
  workspaceId: z.string(),
  repoId: z.string().nullable(),
  repoFullName: z.string().nullable(),
  ownerId: z.string().nullable(),
  name: z.string(),
  icon: z.string().nullable(),
  branch: z.string().nullable(),
  status: z.enum(DESIGN_STATUSES),
  settledAt: z.date().nullable(),
  seq: z.number(),
  previewSeq: z.number().nullable(),
  agentState: z.enum(AGENT_STATES),
  agentStatus: z.string().nullable(),
  needsYouCount: z.number(),
  prNumber: z.number().nullable(),
  prState: z.enum(PR_STATES).nullable(),
  prChecks: z.enum(PR_CHECKS),
  lastActivityAt: z.date(),
  createdAt: z.date(),
  seenSeq: z.number().nullable(),
  seenThreadSeq: z.number().nullable(),
});

const DesignList = z.object({ designs: z.array(DesignRow) });

/**
 * A workspace's designs, for a first paint; the `workspace.designs` live query keeps them
 * fresh. Mounted under `/workspaces/:workspaceId/designs`. Like the live query, it lists the
 * designs in repos GitHub lets the person read, and their own Scratch designs.
 */
export const workspaceDesigns = new Hono<AppEnv>().get(
  "/",
  access.user,
  validate("param", z.object({ workspaceId: z.string().min(1).max(64) })),
  async (c) => {
    const workspace = await requireWorkspace(c, c.req.valid("param").workspaceId);
    await refreshWorkspaceRepoAccess(c.var.deps, { user: c.var.actor.user, workspace });
    const designs = await listWorkspaceDesigns(c.var.deps.db, {
      workspaceId: workspace.id,
      userId: c.var.actor.user.id,
    });
    return c.json(DesignList.parse({ designs }));
  },
);
