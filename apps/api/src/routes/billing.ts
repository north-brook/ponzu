import { getWorkspace, readCardSetup, takeWebhookDelivery } from "@ponzu/db";
import { Hono } from "hono";
import { z } from "zod";
import { access } from "../auth/access.ts";
import { requireWorkspace } from "../auth/authorize.ts";
import {
  cardSetupStatus,
  requireBillingOn,
  settleFromStripe,
  startCardSetup,
  stripeFailure,
} from "../billing/cards.ts";
import { type ReturnPage, renderReturnPage } from "../billing/return-page.ts";
import {
  isActedOn,
  STRIPE_WEBHOOK_JOB,
  STRIPE_WEBHOOK_JOB_ATTEMPTS,
  stripeJobPayload,
} from "../billing/webhook.ts";
import { WebhookSignatureError } from "../deps/payments.ts";
import { LINK_TARGETS } from "../github/link-scheme.ts";
import { SETUP_PAGE_HEADERS } from "../github/setup-page.ts";
import type { AppEnv } from "../http/context.ts";
import { ApiError } from "../http/errors.ts";
import { clientIp } from "../http/request.ts";
import { validate } from "../http/validate.ts";
import { runJob } from "../jobs/run.ts";

/*
 * Cards and Stripe's webhook (docs/cloud.md, "Billing", "Cards" and "Webhooks"). Every route
 * here is new with billing and answers nothing useful until PONZU_BILLING is `on`: before then
 * each refuses before it reads or writes anything (409 `billing_not_set_up`, or 404 for the
 * webhook and the return page, which no app calls), and Stripe is never asked.
 */

const WorkspaceParam = z.object({ id: z.string().min(1).max(64) });
const SetupParam = z.object({ id: z.string().regex(/^auth_[A-Za-z0-9]{1,64}$/) });

const StartBody = z.object({
  /** The monthly cap chosen with the card, in whole dollars: set once the card is added. */
  capUsd: z.number().int().min(1).max(1_000_000),
  /**
   * The scheme of the asking app's links, which the return page opens, or `none` for a build
   * that takes none and learns of the card by asking. Left out, it is `none`.
   */
  scheme: z.enum(LINK_TARGETS).optional(),
  /** Where the admin started: the wall on a send, or Settings. For analytics only. */
  source: z.enum(["wall", "settings"]).optional(),
});

const Started = z.object({
  /** The app's handle on this setup, for `GET /v1/billing/card-setups/:id`. */
  id: z.string(),
  /** Stripe's Checkout page, to open in the browser. */
  url: z.url(),
});

const SetupState = z.object({
  status: z.enum(["waiting", "added", "cancelled", "expired", "failed"]),
  workspaceId: z.string(),
});

const Portal = z.object({ url: z.url() });

// What Checkout and the portal send back. A browser brings it, so any of it can be anything: a
// value that is not what they send is treated as absent.
const ReturnQuery = z.object({
  setup: z
    .string()
    .regex(/^auth_[A-Za-z0-9]{1,64}$/)
    .optional()
    .catch(undefined),
  cancelled: z.literal("1").optional().catch(undefined),
  kind: z.literal("portal").optional().catch(undefined),
});

export const billing = new Hono<AppEnv>()
  /**
   * Begin adding the workspace's card: admins only. Answers Stripe's Checkout page to open in
   * the browser, and the setup's id to poll. 409 `billing_not_set_up` unless billing is on; 400
   * `cap_too_low` below what this month has billed; 503 `upstream_unavailable` when Stripe
   * cannot be reached.
   */
  .post(
    "/workspaces/:id/billing/card-setups",
    access.user,
    validate("param", WorkspaceParam),
    validate("json", StartBody),
    async (c) => {
      const { deps } = c.var;
      requireBillingOn(deps);
      const workspace = await requireWorkspace(c, c.req.valid("param").id, "admin");
      const body = c.req.valid("json");
      const started = await startCardSetup(
        { ...deps, log: c.var.log },
        {
          user: c.var.actor.user,
          workspaceId: workspace.id,
          capUsd: body.capUsd,
          scheme: body.scheme ?? "none",
          source: body.source ?? "settings",
          ip: clientIp(c.req.raw.headers) ?? null,
        },
      );
      return c.json(Started.parse(started), 201);
    },
  )

  /**
   * How a card setup this person started stands: what the app asks every two seconds while
   * Checkout is open, so it hears the card without the return page's link.
   */
  .get("/billing/card-setups/:id", access.user, validate("param", SetupParam), async (c) => {
    const { deps } = c.var;
    requireBillingOn(deps);
    const status = await cardSetupStatus(
      { ...deps, log: c.var.log },
      { id: c.req.valid("param").id, userId: c.var.actor.user.id },
    );
    if (!status) throw new ApiError(404, "not_found", "There is no such card setup.");
    return c.json(SetupState.parse(status));
  })

  /**
   * Where Checkout and the customer portal send the browser back. It has no bearer token: the
   * setup's id only picks the row, and what happened is read from Stripe. The answer is a page
   * for a person, and every outcome is one.
   */
  .get("/billing/return", access.public, validate("query", ReturnQuery), async (c) => {
    const { deps } = c.var;
    if (deps.features.billing !== "on" || !deps.payments.enabled) {
      throw new ApiError(404, "not_found", "There is nothing at this address.");
    }
    const query = c.req.valid("query");
    let page: ReturnPage;
    if (query.kind === "portal") {
      page = { kind: "portal" };
    } else {
      const setup = query.setup ? await readCardSetup(deps.db, { id: query.setup }) : null;
      if (!setup) {
        page = { kind: "unknown" };
      } else {
        const settled = await settleFromStripe({ ...deps, log: c.var.log }, setup, {
          cancelled: query.cancelled === "1",
        }).catch((error) => {
          c.var.log.error("card_setup_return_failed", { setupId: setup.id, error });
          return { setup, unreachable: true };
        });
        const { outcome, scheme } = settled.setup.payload;
        page =
          outcome === "added" || outcome === "cancelled"
            ? { kind: outcome, setupId: setup.id, scheme }
            : outcome === "expired"
              ? { kind: "expired" }
              : settled.unreachable || outcome === "failed"
                ? { kind: "unreachable" }
                : // Back from Checkout with the page still open at Stripe: not finished there.
                  { kind: "cancelled", setupId: setup.id, scheme };
      }
    }
    const { html, csp } = await renderReturnPage(page);
    return c.html(html, page.kind === "unreachable" ? 502 : 200, {
      ...SETUP_PAGE_HEADERS,
      "content-security-policy": csp,
    });
  })

  /**
   * Stripe's customer portal for the workspace, where an admin changes the card or reads
   * invoices: admins only. 409 `no_card` when the workspace has no Stripe customer yet.
   */
  .post(
    "/workspaces/:id/billing/portal",
    access.user,
    validate("param", WorkspaceParam),
    async (c) => {
      const { deps } = c.var;
      requireBillingOn(deps);
      const member = await requireWorkspace(c, c.req.valid("param").id, "admin");
      const workspace = await getWorkspace(deps.db, member.id);
      if (!workspace?.stripeCustomerId) {
        throw new ApiError(409, "no_card", "Add a card first.");
      }
      const url = await deps.payments
        .portalUrl({
          customerId: workspace.stripeCustomerId,
          returnUrl: `${deps.config.sandbox.apiUrl}/v1/billing/return?kind=portal`,
        })
        .catch((error) => {
          throw stripeFailure(error);
        });
      return c.json(Portal.parse({ url }));
    },
  )

  /**
   * Stripe's webhook deliveries. Open to anyone, so nothing is read until the signature over
   * the raw body checks out. An event of another deployment's, or of the other mode, is
   * acknowledged and dropped, as is one seen before; one this API acts on is recorded as a job,
   * answered, and its work done after (`billing/webhook.ts`).
   */
  .post("/stripe/webhook", access.public, async (c) => {
    const { deps } = c.var;
    if (!deps.payments.enabled || deps.features.billing !== "on") {
      throw new ApiError(404, "not_found", "There is nothing at this address.");
    }
    const raw = await c.req.text();
    const signature = c.req.header("stripe-signature");
    if (!signature) {
      throw new ApiError(400, "signature_invalid", "This delivery is not signed by Stripe.");
    }
    let event: Awaited<ReturnType<typeof deps.payments.verifyWebhook>>;
    try {
      event = await deps.payments.verifyWebhook(raw, signature);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        throw new ApiError(400, "signature_invalid", "This delivery is not signed by Stripe.");
      }
      throw error;
    }
    const received = { received: true } as const;
    if (event.foreign !== null) {
      c.var.log.info("stripe_webhook_skipped", {
        eventId: event.id,
        type: event.type,
        reason: event.foreign,
      });
      return c.json(received);
    }
    if (!isActedOn(event.type)) {
      c.var.log.info("stripe_webhook_skipped", {
        eventId: event.id,
        type: event.type,
        reason: "not_acted_on",
      });
      return c.json(received);
    }
    // Stripe sends an event again until it hears a 2xx, so its work is a job before it does:
    // the cron retries what fails here or dies with this instance.
    const worker = `request:${c.var.requestId}`;
    const job = {
      kind: STRIPE_WEBHOOK_JOB,
      payload: stripeJobPayload(event),
      runAt: new Date(deps.clock.now()),
      lockedBy: worker,
      maxAttempts: STRIPE_WEBHOOK_JOB_ATTEMPTS,
    };
    const jobId = await takeWebhookDelivery(deps.db, {
      delivery: { source: "stripe", deliveryId: event.id, event: event.type },
      job,
    });
    if (!jobId) {
      c.var.log.info("stripe_webhook_skipped", {
        eventId: event.id,
        type: event.type,
        reason: "duplicate",
      });
      return c.json(received);
    }
    deps.background(
      `stripe_${event.type}`,
      runJob({ ...deps, log: c.var.log }, { id: jobId, attempts: 1, ...job }, worker),
    );
    return c.json(received);
  });
