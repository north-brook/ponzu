import { takeWebhookDelivery, WORKSPACE_KINDS } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { listGithubAccounts } from "../github/accounts.ts";
import { createInstallLink, finishSetup, installStatus, SETUP_RESULTS } from "../github/install.ts";
import { LINK_TARGETS, type LinkTarget } from "../github/link-scheme.ts";
import { renderSetupPage, SETUP_PAGE_HEADERS, type SetupPage } from "../github/setup-page.ts";
import { syncGithub } from "../github/sync.ts";
import {
  planDelivery,
  verifySignature,
  WEBHOOK_JOB,
  WEBHOOK_JOB_ATTEMPTS,
  type WebhookJobPayload,
} from "../github/webhook.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { validate } from "../http/validate.ts";
import { runJob } from "../jobs/run.ts";

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
      /**
       * Everyone GitHub says can reach its repos, whether or not they have opened Ponzu. Null
       * while that is not known, for the person's own account, and for an account they reach
       * only as an outside collaborator.
       */
      memberCount: z.number().nullable(),
    }),
  ),
});

const InstallLinkBody = z.object({
  client: z.enum(["mac", "ios"]),
  /**
   * The scheme of the asking app's links, which the setup page links back to, or `none` for a
   * build that takes no links. Left out, the page links nowhere. Only these, so no one can make
   * the page link anywhere else (link-scheme.ts).
   */
  scheme: z.enum(LINK_TARGETS).optional(),
  /** The account to suggest on GitHub's page. GitHub may ignore it. */
  githubAccountId: z.number().int().positive().optional(),
});

const InstallLink = z.object({
  /** The app's handle on this install, for `GET /v1/github/installs/:id`. */
  id: z.string(),
  url: z.url(),
  expiresAt: z.date(),
});

const InstallParam = z.object({ id: z.string().regex(/^auth_[A-Za-z0-9]{1,64}$/) });

const InstallState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("waiting"), expiresAt: z.date() }),
  z.object({
    status: z.literal("settled"),
    result: z.enum(SETUP_RESULTS as [SetupPage["kind"], ...SetupPage["kind"][]]),
    workspaceId: z.string().nullable(),
  }),
  z.object({ status: z.literal("expired") }),
]);

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
   * How an install this person started stands: what an app asks while GitHub's page is open, so
   * it hears the outcome without the setup page's link (a build that takes none, or a link
   * nobody answered), comes forward and moves on.
   */
  .get("/installs/:id", access.user, validate("param", InstallParam), async (c) => {
    const status = await installStatus(c.var.deps, c.var.actor.user.id, c.req.valid("param").id);
    if (!status) throw new ApiError(404, "not_found", "There is no such install.");
    return c.json(InstallState.parse(status));
  })

  /**
   * The App's Setup URL: GitHub's install page sends the browser here. It has no bearer token,
   * so the state it carries is what says who started it (`finishSetup`). The answer is a page
   * for a person, not JSON, and every outcome is one: a failure says so on the page.
   */
  .get("/setup", access.public, validate("query", SetupQuery), async (c) => {
    const query = c.req.valid("query");
    let finished: { page: SetupPage; target: LinkTarget | null };
    try {
      finished = await finishSetup(
        { ...c.var.deps, log: c.var.log },
        {
          state: query.state,
          installationId: query.installation_id,
          setupAction: query.setup_action,
        },
      );
    } catch (error) {
      c.var.log.error("github_setup_failed", { error });
      // Failing before the state was read: no app can be named.
      finished = { page: { kind: "failed" }, target: null };
    }
    const { page, target } = finished;
    const { html, csp } = await renderSetupPage(page, target);
    return c.html(html, page.kind === "failed" ? 502 : 200, {
      ...SETUP_PAGE_HEADERS,
      "content-security-policy": csp,
    });
  })

  /**
   * GitHub's webhook deliveries. Open to anyone, so nothing is read until the signature over
   * the raw bytes checks out. A delivery seen before is acknowledged and dropped; a new one is
   * recorded as a job, answered, and its work done after (`planDelivery`).
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
    // GitHub never sends a delivery again by itself, so its work is a job before it is told
    // the delivery arrived: the cron retries what fails here or dies with this instance.
    const worker = `request:${c.var.requestId}`;
    const job = {
      kind: WEBHOOK_JOB,
      payload: { event, payload: plan.payload } satisfies WebhookJobPayload,
      runAt: new Date(deps.clock.now()),
      lockedBy: worker,
      maxAttempts: WEBHOOK_JOB_ATTEMPTS,
    };
    const jobId = await takeWebhookDelivery(deps.db, {
      delivery: { source: "github", deliveryId, event },
      job,
    });
    if (!jobId) {
      c.var.log.info("github_webhook_skipped", { event, deliveryId, reason: "duplicate" });
      return c.body(null, 204);
    }
    deps.background(
      `github_${event}`,
      runJob({ ...deps, log: c.var.log }, { id: jobId, attempts: 1, ...job }, worker),
    );
    return c.body(null, 202);
  });
