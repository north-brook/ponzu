import {
  getClaudeAccount,
  listUserWorkspaces,
  MEMBER_ROLES,
  recordOnboardingStep,
  WORKSPACE_KINDS,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import type { AppEnv } from "../http/context.ts";
import { validate } from "../http/validate.ts";
import { ClaudeAccountView, claudeAccountView } from "./claude.ts";
import { Profile, toProfile } from "./profile.ts";

/**
 * What an app needs at launch to decide where the person lands. Each part is its own object
 * so a later module can add to one (devices, agent defaults, ping settings) without moving
 * what is here.
 */
/** Guided setup: when each step that leaves no other trace was finished, or null. */
const Onboarding = z.object({
  whereConfirmedAt: z.date().nullable(),
  iphoneStepSeenAt: z.date().nullable(),
});

const OnboardingBody = z.object({
  /** Continue on "Where do you build?", or Start building on the iPhone step. */
  step: z.enum(["where", "iphone"]),
});

const Me = z.object({
  user: Profile,
  onboarding: Onboarding,
  /**
   * The person's own Claude, or null if none is connected: whether their canvases can run, and
   * whether it runs out soon. Never its credential.
   */
  claudeAccount: ClaudeAccountView.nullable(),
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

export const me = new Hono<AppEnv>()
  .get("/", access.user, async (c) => {
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
        claudeAccount: claudeAccountView(claudeAccount, c.var.deps.clock.now()),
        workspaces: workspaces.map((workspace) => ({
          ...workspace,
          installed: workspace.installationId !== null,
          suspended: workspace.suspendedAt !== null,
        })),
      }),
    );
  })

  /**
   * Records a guided setup step as done, so setup picks up past it on every device. The first
   * time counts: doing it again changes nothing. Answers where setup stands.
   */
  .post("/onboarding", access.user, validate("json", OnboardingBody), async (c) => {
    const { deps, actor } = c.var;
    const done = await recordOnboardingStep(deps.db, {
      userId: actor.user.id,
      step: c.req.valid("json").step,
      at: new Date(deps.clock.now()),
    });
    return c.json(
      Onboarding.parse({ whereConfirmedAt: done.whereAt, iphoneStepSeenAt: done.iphoneAt }),
    );
  });
