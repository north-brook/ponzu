import {
  getClaudeAccount,
  listUserWorkspaces,
  MEMBER_ROLES,
  recordOnboardingStep,
  setShareUsage,
  WORKSPACE_KINDS,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { BILLING_MODES } from "../features.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
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

/**
 * Settings › Account › Share usage data. Off, the apps report nothing, the API sends nothing
 * about the person to PostHog, and the agent's turns they begin are not traced
 * (docs/analytics.md, "Turning it off").
 */
const Privacy = z.object({ shareUsage: z.boolean() });

const Me = z.object({
  user: Profile,
  onboarding: Onboarding,
  privacy: Privacy,
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
  /**
   * The switches an app shows or hides things by: billing's mode, and whether pings to phones
   * and the email digest can be sent at all. The rest of `deps.features` is the API's own.
   */
  features: z.object({
    billing: z.enum(BILLING_MODES),
    push: z.boolean(),
    email: z.boolean(),
  }),
});

export const me = new Hono<AppEnv>()
  .get("/", access.user, async (c) => {
    const { db, features } = c.var.deps;
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
        privacy: { shareUsage: user.shareUsage },
        claudeAccount: claudeAccountView(claudeAccount, c.var.deps.clock.now()),
        workspaces: workspaces.map((workspace) => ({
          ...workspace,
          installed: workspace.installationId !== null,
          suspended: workspace.suspendedAt !== null,
        })),
        features: { billing: features.billing, push: features.push, email: features.email },
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
  })

  /**
   * Turns Share usage data on or off, for every device the person uses. It captures nothing,
   * either way. This instance reads who has turned it off again at its next send; others within
   * a minute. A turn already running keeps the trace flag it began with.
   */
  .patch("/privacy", access.user, validate("json", Privacy), async (c) => {
    const { deps, actor } = c.var;
    const saved = await setShareUsage(deps.db, {
      userId: actor.user.id,
      shareUsage: c.req.valid("json").shareUsage,
    });
    if (!saved) throw new ApiError(404, "not_found", "There is no such person.");
    deps.analytics.sharingChanged();
    return c.json(Privacy.parse(saved));
  });
