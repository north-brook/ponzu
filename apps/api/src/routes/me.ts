import {
  CLAUDE_ACCOUNT_KINDS,
  CLAUDE_ACCOUNT_STATUSES,
  getClaudeAccount,
  listUserWorkspaces,
  MEMBER_ROLES,
  WORKSPACE_KINDS,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";
import { Profile, toProfile } from "./profile.ts";

/**
 * What an app needs at launch to decide where the person lands. Each part is its own object
 * so a later module can add to one (devices, agent defaults, ping settings) without moving
 * what is here.
 */
const Me = z.object({
  user: Profile,
  /** Guided setup: when each step that leaves no other trace was finished, or null. */
  onboarding: z.object({
    whereConfirmedAt: z.date().nullable(),
    iphoneStepSeenAt: z.date().nullable(),
  }),
  /** The person's own Claude, or null if none is connected. Never its credential. */
  claudeAccount: z
    .object({
      kind: z.enum(CLAUDE_ACCOUNT_KINDS),
      status: z.enum(CLAUDE_ACCOUNT_STATUSES),
    })
    .nullable(),
  /** As of the last sync with GitHub, which the workspaces module does. */
  workspaces: z.array(
    z.object({
      id: z.string(),
      githubLogin: z.string(),
      name: z.string(),
      kind: z.enum(WORKSPACE_KINDS),
      avatarUrl: z.string().nullable(),
      role: z.enum(MEMBER_ROLES),
      /** False once the GitHub App has been removed from the account. */
      installed: z.boolean(),
      suspended: z.boolean(),
    }),
  ),
});

export const me = new Hono<AppEnv>().get("/", access.user, async (c) => {
  const { db } = c.var.deps;
  const { user } = c.var.actor;
  const [claudeAccount, workspaces] = await Promise.all([
    getClaudeAccount(db, user.id),
    listUserWorkspaces(db, user.id),
  ]);
  return c.json(
    Me.parse({
      user: toProfile(user),
      onboarding: {
        whereConfirmedAt: user.onboardingWhereAt,
        iphoneStepSeenAt: user.onboardingIphoneAt,
      },
      claudeAccount,
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        installed: workspace.installationId !== null,
        suspended: workspace.suspendedAt !== null,
      })),
    }),
  );
});
