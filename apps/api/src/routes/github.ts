import { forgetWebhookDelivery, recordWebhookDelivery, WORKSPACE_KINDS } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { listGithubAccounts } from "../github/accounts.ts";
import { createInstallLink, finishSetup } from "../github/install.ts";
import { renderSetupPage, SETUP_PAGE_HEADERS, type SetupPage } from "../github/setup-page.ts";
import { syncGithub } from "../github/sync.ts";
import { planDelivery, verifySignature } from "../github/webhook.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";

const Accounts = z.object({
  /** The person's own account first, then every account with the App that they reach. */
  accounts: z.array(
    z.object({
      githubAccountId: z.number(),
      login: z.string(),
      name: z.string(),
      avatarUrl: z.string().nullable(),
      kind: z.enum(WORKSPACE_KINDS),
      status: z.enum(["ready", "not_installed"]),
      workspaceId: z.string().nullable(),
      suspended: z.boolean(),
      /** Ready organizations only: the people in its workspace. */
      memberCount: z.number().nullable(),
    }),
  ),
});

const InstallLinkBody = z.object({
  client: z.enum(["mac", "ios"]),
  /** The account to suggest on GitHub's page. GitHub may ignore it. */
  githubAccountId: z.number().int().positive().optional(),
});

const InstallLink = z.object({ url: z.url(), expiresAt: z.date() });

// What GitHub's install page sends back. A browser brings it, so any of it can be anything:
// a value that is not what GitHub sends is treated as absent, and the page says so gently.
const SetupQuery = z.object({
  installation_id: z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .optional()
    .catch(undefined),
  setup_action: z.enum(["install", "update", "request"]).optional().catch(undefined),
  state: z.string().max(512).optional().catch(undefined),
});

const DeliveryHeaders = z.object({
  event: z.string().regex(/^[a-z_]{1,64}$/),
  /** A GUID. */
  deliveryId: z.string().regex(/^[\w-]{1,64}$/),
});

export const github = new Hono<AppEnv>()
  /** What the "Where do you design?" step lists, as of the last sync. */
  .get("/accounts", access.user, async (c) => {
    const accounts = await listGithubAccounts(c.var.deps, c.var.actor.user);
    return c.json(Accounts.parse({ accounts }));
  })

  /** Sync with GitHub now, then list the accounts: what an app does when it comes back to focus. */
  .post("/sync", access.user, async (c) => {
    const { user } = c.var.actor;
    await syncGithub({ ...c.var.deps, log: c.var.log }, user.id);
    const accounts = await listGithubAccounts(c.var.deps, user);
    return c.json(Accounts.parse({ accounts }));
  })

  /** Where to send the person to install the App, with a state good for one return. */
  .post("/install-link", access.user, validate("json", InstallLinkBody), async (c) => {
    const link = await createInstallLink(c.var.deps, c.var.actor.user.id, c.req.valid("json"));
    return c.json(InstallLink.parse(link));
  })

  /**
   * The App's Setup URL: GitHub's install page sends the browser here. It has no bearer token,
   * so the state it carries is what says who started it (`finishSetup`). The answer is a page
   * for a person, not JSON, and every outcome is one: a failure says so on the page.
   */
  .get("/setup", access.public, validate("query", SetupQuery), async (c) => {
    const query = c.req.valid("query");
    let page: SetupPage;
    try {
      page = await finishSetup(
        { ...c.var.deps, log: c.var.log },
        {
          state: query.state,
          installationId: query.installation_id,
          setupAction: query.setup_action,
        },
      );
    } catch (error) {
      c.var.log.error("github_setup_failed", { error });
      page = { kind: "failed" };
    }
    return c.html(renderSetupPage(page), page.kind === "failed" ? 502 : 200, SETUP_PAGE_HEADERS);
  })

  /**
   * GitHub's webhook deliveries. Open to anyone, so nothing is read until the signature over
   * the raw bytes checks out. A delivery seen before is acknowledged and dropped; a new one is
   * answered at once and its work done after (`planDelivery`). If that work fails the delivery
   * is given back, so redelivering it from the App's settings runs it again.
   */
  .post("/webhook", access.public, async (c) => {
    const { deps } = c.var;
    const body = new Uint8Array(await c.req.arrayBuffer());
    const signature = c.req.header("x-hub-signature-256");
    if (!verifySignature(deps.config.githubApp.webhookSecret, body, signature)) {
      throw new ApiError(401, "signature_invalid", "This delivery is not signed by GitHub.");
    }
    const headers = DeliveryHeaders.safeParse({
      event: c.req.header("x-github-event"),
      deliveryId: c.req.header("x-github-delivery"),
    });
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      payload = undefined;
    }
    if (!headers.success || payload === undefined) {
      throw new ApiError(400, "invalid_request", "This is not a GitHub webhook delivery.");
    }
    const { event, deliveryId } = headers.data;

    const plan = planDelivery(event, payload);
    if (plan.kind !== "work") {
      c.var.log[plan.kind === "malformed" ? "warn" : "info"]("github_webhook_skipped", {
        event,
        deliveryId,
        reason: plan.kind,
      });
      return c.body(null, 204);
    }
    const delivery = { source: "github" as const, deliveryId, event };
    if (!(await recordWebhookDelivery(deps.db, delivery))) {
      c.var.log.info("github_webhook_skipped", { event, deliveryId, reason: "duplicate" });
      return c.body(null, 204);
    }
    const work = plan.work({ ...deps, log: c.var.log }).catch(async (error) => {
      await forgetWebhookDelivery(deps.db, delivery).catch((forgetting) => {
        c.var.log.error("github_webhook_not_given_back", { deliveryId, error: forgetting });
      });
      throw error;
    });
    deps.background(`github_${event}`, work);
    return c.body(null, 202);
  });
