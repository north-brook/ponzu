import {
  CLAUDE_ACCOUNT_KINDS,
  type ClaudeAccount,
  getClaudeAccount,
  setAgentDefaults,
} from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { connectClaude, disconnectClaude } from "../claude/accounts.ts";
import {
  checkOffered,
  DEFAULT_EFFORT,
  EFFORTS,
  effortOrDefault,
  type ModelOffer,
  modelOrDefault,
  offeredEfforts,
  offerFor,
} from "../claude/models.ts";
import { abandonSignIn, finishSignIn, startSignIn } from "../claude/sign-in.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";

/*
 * A person's own Claude (docs/cloud.md, "Credentials"): which account canvases they start run
 * on, connecting one by a subscription sign-in or an API key, disconnecting it, and the model
 * and effort their new canvases start on. Never the credential: it goes into the vault and
 * comes out only into a sandbox.
 */

/** From four weeks before a subscription's token runs out, the apps ask the person to renew it. */
const EXPIRES_SOON_MS = 28 * 24 * 3600_000;

/** A person's Claude as the apps show it. */
export const ClaudeAccountView = z.object({
  kind: z.enum(CLAUDE_ACCOUNT_KINDS),
  /** `expired` once a subscription's token has run out. */
  status: z.enum(["connected", "expired"]),
  /** "Claude Max", "Claude subscription" or "Anthropic API key · sk-ant-…4f2a". */
  label: z.string(),
  email: z.string().nullable(),
  connectedAt: z.date(),
  /** When a subscription's token runs out. Null for an API key. */
  expiresAt: z.date().nullable(),
  /** Whether it runs out within four weeks: time to sign in again. */
  expiresSoon: z.boolean(),
  /** Until when its plan is at a limit, if it is. */
  limitedUntil: z.date().nullable(),
  /**
   * Each window of its plan's limits as a runner on it last saw it, in the Agent SDK's names
   * (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, …): the apps show those they
   * know. Empty before any canvas has run on it; null for an API key, which has no plan.
   */
  limits: z
    .array(
      z.object({
        window: z.string(),
        utilization: z.number().nullable(),
        resetsAt: z.date().nullable(),
      }),
    )
    .nullable(),
});

/** The account as the apps show it; null when none is connected. */
export function claudeAccountView(
  account: ClaudeAccount | null,
  now: number,
): z.input<typeof ClaudeAccountView> | null {
  if (!account || account.status === "revoked") return null;
  const expiresAt = account.expiresAt?.getTime() ?? null;
  const expired = account.status === "expired" || (expiresAt !== null && expiresAt <= now);
  return {
    kind: account.kind,
    status: expired ? "expired" : "connected",
    label:
      account.kind === "api_key"
        ? `Anthropic API key${account.keyHint ? ` · sk-ant-…${account.keyHint}` : ""}`
        : (account.planLabel ?? "Claude subscription"),
    email: account.email,
    connectedAt: account.connectedAt,
    expiresAt: account.expiresAt,
    expiresSoon: expiresAt !== null && expiresAt - now < EXPIRES_SOON_MS,
    limitedUntil:
      account.limitedUntil && account.limitedUntil.getTime() > now ? account.limitedUntil : null,
    limits:
      account.kind === "api_key"
        ? null
        : (account.limits ?? []).map((limit) => ({
            window: limit.window,
            utilization: limit.utilization,
            resetsAt: limit.resetsAt ? new Date(limit.resetsAt) : null,
          })),
  };
}

const AccountAnswer = z.object({ account: ClaudeAccountView.nullable() });

const ApiKeyBody = z.object({
  key: z.string().trim().min(20).max(400).regex(/^\S+$/, "An API key has no spaces in it."),
});
const SignInParams = z.object({ id: z.string().min(1).max(64) });
const CodeBody = z.object({ code: z.string().trim().min(1).max(2_000) });
const SignInView = z.object({ id: z.string(), authorizeUrl: z.string(), expiresAt: z.date() });

const DefaultsBody = z
  .object({ model: z.string().min(1).max(200), effort: z.enum(EFFORTS) })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "Say what to change.");
const DefaultsView = z.object({
  /** What a new canvas runs on: the saved choice while the account offers it, or the default. */
  model: z.string(),
  effort: z.enum(EFFORTS),
  /**
   * What the person's Claude account offers, in the order the picker lists them: what Claude
   * Code reported for it, or the hand-kept list until a runner has (docs/cloud.md, "Models").
   */
  models: z.array(
    z.object({ id: z.string(), label: z.string(), efforts: z.array(z.enum(EFFORTS)) }),
  ),
  /** Every effort an offered model takes; each model's own are on it. */
  efforts: z.array(z.enum(EFFORTS)),
});

const defaults = (offer: ModelOffer, model: string | null, effort: string | null) => {
  const runs = modelOrDefault(offer, model);
  return DefaultsView.parse({
    model: runs,
    // A model that takes no effort shows the default, which it is never sent.
    effort: effortOrDefault(offer, runs, effort) ?? DEFAULT_EFFORT,
    models: offer.models,
    efforts: offeredEfforts(offer),
  });
};

/** What the person's own Claude account offers. */
async function offerOf(deps: AppEnv["Variables"]["deps"], userId: string): Promise<ModelOffer> {
  return offerFor(await getClaudeAccount(deps.db, userId));
}

export const claude = new Hono<AppEnv>()
  .use(access.user)

  /** The person's Claude, or null. */
  .get("/", async (c) => {
    const { deps, actor } = c.var;
    const account = await getClaudeAccount(deps.db, actor.user.id);
    return c.json(AccountAnswer.parse({ account: claudeAccountView(account, deps.clock.now()) }));
  })

  /**
   * Connects an Anthropic API key in place of whatever was connected, once Anthropic says it
   * takes it. Usage bills to the key's own Console account.
   */
  .post("/api-key", validate("json", ApiKeyBody), async (c) => {
    const { deps, actor } = c.var;
    const { key } = c.req.valid("json");
    if (!(await deps.anthropic.acceptsApiKey(key))) {
      throw new ApiError(400, "claude_key_invalid", "Anthropic didn't accept that key.");
    }
    const account = await connectClaude(deps, actor.user.id, {
      kind: "api_key",
      credential: key,
      keyHint: key.slice(-4),
      expiresAt: null,
    });
    return c.json(AccountAnswer.parse({ account: claudeAccountView(account, deps.clock.now()) }));
  })

  /**
   * Starts signing in with a Claude subscription: open `authorizeUrl`, approve, and send the
   * code claude.ai shows to `/sign-ins/:id/code` before `expiresAt`.
   */
  .post("/sign-ins", async (c) => {
    const started = await startSignIn(c.var.deps, c.var.actor.user.id);
    return c.json(SignInView.parse(started), 201);
  })

  /**
   * Finishes a sign-in with the code claude.ai showed, and connects the subscription in place of
   * whatever was connected. A sign-in takes one code: after a wrong one, open sign-in again.
   */
  .post(
    "/sign-ins/:id/code",
    validate("param", SignInParams),
    validate("json", CodeBody),
    async (c) => {
      const { deps, actor } = c.var;
      const account = await finishSignIn(deps, actor.user.id, {
        id: c.req.valid("param").id,
        code: c.req.valid("json").code,
      });
      return c.json(AccountAnswer.parse({ account: claudeAccountView(account, deps.clock.now()) }));
    },
  )

  /** Gives up a sign-in: the person chose another way. */
  .delete("/sign-ins/:id", validate("param", SignInParams), async (c) => {
    await abandonSignIn(c.var.deps, c.var.actor.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  })

  /**
   * Disconnects the person's Claude: the credential is destroyed, their canvases wait until they
   * connect again, and what runs on it now is stopped.
   */
  .delete("/", async (c) => {
    await disconnectClaude(c.var.deps, c.var.actor.user.id);
    return c.body(null, 204);
  })

  /** The model and effort the person's new canvases start on, and what there is to choose. */
  .get("/defaults", async (c) => {
    const { user } = c.var.actor;
    const offer = await offerOf(c.var.deps, user.id);
    return c.json(defaults(offer, user.defaultModel, user.defaultEffort));
  })

  /** Only what the person's account offers can be chosen. */
  .patch("/defaults", validate("json", DefaultsBody), async (c) => {
    const { user } = c.var.actor;
    const body = c.req.valid("json");
    const offer = await offerOf(c.var.deps, user.id);
    checkOffered(offer, body.model ?? modelOrDefault(offer, user.defaultModel), body.effort);
    const saved = await setAgentDefaults(c.var.deps.db, { userId: user.id, ...body });
    return c.json(defaults(offer, saved.model, saved.effort));
  });
