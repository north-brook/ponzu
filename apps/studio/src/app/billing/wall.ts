import { type Api, ApiError } from "@ponzu/client";
import {
  type BillingReason,
  type BillingRequired,
  billingRequired,
  cardSetupError,
} from "@ponzu/client/model/billing";
import type { DeepLink } from "@ponzu/desktop/bridge";
import type { Analytics } from "../analytics/analytics.ts";
import type { BillingDialogReason } from "../analytics/events.ts";
import {
  type CardSetupWatch,
  realScheduler,
  type Scheduler,
  watchCardSetup,
} from "./card-setups.ts";

/*
 * The billing wall (docs/cloud.md, "Billing"; the billing plan, §8.1). While billing is on, the
 * API answers a send that would start work past a limit with 402 `billing_required` and writes
 * nothing. The send is held here, not lost: the dialog its reason calls for opens, and once the
 * card is added, the cap raised or the invoice paid, the held send runs, once. Dismissed, it is
 * dropped, and whoever sent it keeps its words (the create page's prompt, a message's bubble with
 * Retry). The thread's billing lines and Plan and usage open the same dialogs with nothing held.
 *
 * With billing off the API never answers 402 `billing_required`, so none of this opens.
 */

/** A send held at the wall, to run once the limit is lifted. */
export interface Held {
  kind: "create" | "message";
  run: () => void | Promise<void>;
  /**
   * The send came to nothing after all: the dialog was dismissed, or `run` failed. For a send
   * whose words are kept nowhere else (a create's first message sent after its images), so the
   * person is told it didn't go.
   */
  dropped?: () => void;
}

/** Adding a card in the browser: the button's state and what went wrong last. */
export interface CardStep {
  status: "idle" | "opening" | "waiting";
  error: string | null;
}

export type WallDialog =
  | { kind: "free_used" | "add_card"; card: CardStep }
  | { kind: "cap_reached"; status: "idle" | "submitting"; error: string | null }
  | { kind: "payment_failed" };

export interface WallSnapshot {
  open: boolean;
  /** The dialog, kept as it was while it closes so its words hold. */
  dialog: WallDialog | null;
  details: BillingRequired | null;
}

/** How often the payment dialog asks whether the invoice has been paid. */
export const PAID_POLL_MS = 5_000;

const CLOSED: WallSnapshot = { open: false, dialog: null, details: null };

export interface WallDeps {
  api: Pick<Api, "billing" | "usage">;
  openExternal: (url: string) => void;
  onLink: (listener: (link: DeepLink) => void) => () => void;
  comeForward?: () => void;
  /** Read the workspace's usage and `me` again: its card, cap and gate changed. */
  refresh: (workspaceId: string) => void;
  analytics: Pick<Analytics, "capture">;
  scheduler?: Scheduler;
}

export class BillingWall {
  private snapshot: WallSnapshot = CLOSED;
  private held: Held | null = null;
  private watch: CardSetupWatch | null = null;
  private cancelPaidPoll: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: WallDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WallSnapshot => this.snapshot;

  /**
   * A send's failure: when it is the wall's 402, the send is held and its dialog opens (true).
   * Anything else is the caller's to handle (false). A second refusal while a dialog is open
   * replaces the held send with the newer one.
   */
  refused(error: unknown, held: Held): boolean {
    const details = billingRequired(error);
    if (!details) return false;
    this.open(details, held);
    return true;
  }

  /** Opens the dialog for `details.reason`, holding `held` if given (a canvas's line holds none). */
  open(details: BillingRequired, held: Held | null = null): void {
    this.stopWatching();
    this.held = held;
    this.show(details, dialogFor(details.reason));
  }

  /** Settings' and a canvas line's "Add a card": the card and the cap, with nothing held. */
  addCard(details: Omit<BillingRequired, "reason">): void {
    this.stopWatching();
    this.held = null;
    this.show(
      { ...details, reason: "free_used" },
      { kind: "add_card", card: { status: "idle", error: null } },
    );
  }

  /** Stripe's Checkout page for the card, with the cap typed; waits for it to come back. */
  async submitCard(capUsd: number): Promise<void> {
    const { dialog, details } = this.snapshot;
    if (!details || (dialog?.kind !== "free_used" && dialog?.kind !== "add_card")) return;
    if (dialog.card.status !== "idle") return;
    const source = dialog.kind === "add_card" ? "settings" : "wall";
    this.setCard({ status: "opening", error: null });
    let setup: { id: string; url: string };
    try {
      setup = await this.deps.api.billing.startCardSetup(details.workspaceId, { capUsd, source });
    } catch (error) {
      this.setCard({ status: "idle", error: refusalWords(error) });
      return;
    }
    if (this.snapshot.details !== details || !this.snapshot.open) return;
    this.deps.openExternal(setup.url);
    this.setCard({ status: "waiting", error: null });
    this.watch = watchCardSetup({
      api: this.deps.api,
      setupId: setup.id,
      onLink: this.deps.onLink,
      ...(this.deps.comeForward ? { comeForward: this.deps.comeForward } : {}),
      ...(this.deps.scheduler ? { scheduler: this.deps.scheduler } : {}),
      onOutcome: (outcome) => {
        this.watch = null;
        if (outcome === "added") {
          this.deps.refresh(details.workspaceId);
          this.lifted();
          return;
        }
        this.setCard({ status: "idle", error: cardSetupError(outcome, this.held !== null) });
      },
    });
  }

  /** "Cancel" while waiting on the browser: back to the button, the held send still held. */
  cancelCard(): void {
    const { dialog } = this.snapshot;
    if (dialog?.kind !== "free_used" && dialog?.kind !== "add_card") return;
    this.stopWatching();
    this.setCard({ status: "idle", error: null });
  }

  /** The cap-reached dialog: the new cap, then the held send. */
  async submitCap(capUsd: number): Promise<void> {
    const { dialog, details } = this.snapshot;
    if (!details || dialog?.kind !== "cap_reached" || dialog.status === "submitting") return;
    this.set({ dialog: { kind: "cap_reached", status: "submitting", error: null } });
    try {
      await this.deps.api.usage.setCap(details.workspaceId, capUsd);
    } catch (error) {
      this.set({ dialog: { kind: "cap_reached", status: "idle", error: refusalWords(error) } });
      return;
    }
    this.deps.refresh(details.workspaceId);
    this.lifted();
  }

  /**
   * The payment dialog's "Pay invoice": Stripe's page for the invoice, and the dialog waits for it
   * to be paid. An admin whose invoice has no page of its own gets Stripe's portal, which lists it.
   */
  async payInvoice(): Promise<void> {
    const { dialog, details } = this.snapshot;
    if (dialog?.kind !== "payment_failed" || !details?.canManage) return;
    if (details.invoiceUrl) {
      this.deps.openExternal(details.invoiceUrl);
      return;
    }
    try {
      const { url } = await this.deps.api.billing.portal(details.workspaceId);
      if (this.snapshot.details === details && this.snapshot.open) this.deps.openExternal(url);
    } catch {
      // The dialog stays, and its button can be pressed again.
    }
  }

  /** Closed without what it asked for: the held send is dropped (its words stay where they are). */
  dismiss(): void {
    const { dialog, open } = this.snapshot;
    if (!open || !dialog) return;
    this.deps.analytics.capture("billing dialog dismissed", { reason: reasonOf(dialog) });
    const held = this.held;
    this.held = null;
    this.stopWatching();
    this.set({ open: false });
    held?.dropped?.();
  }

  /** The window goes: nothing more is asked or heard. */
  close(): void {
    this.stopWatching();
    this.held = null;
    this.listeners.clear();
  }

  private show(details: BillingRequired, dialog: WallDialog): void {
    this.snapshot = { open: true, dialog, details };
    this.deps.analytics.capture("billing dialog shown", { reason: reasonOf(dialog) });
    if (dialog.kind === "payment_failed") this.pollPaid(details.workspaceId);
    this.emit();
  }

  /** The limit is lifted: the held send runs, once, and the dialog closes. */
  private lifted(): void {
    const held = this.held;
    this.held = null;
    this.stopWatching();
    this.set({ open: false });
    if (!held) return;
    // A run that throws is a send that didn't go: never an unhandled rejection.
    const fail = () => held.dropped?.();
    try {
      const going = held.run();
      if (going) going.catch(fail);
    } catch {
      fail();
    }
  }

  /** While the payment dialog is open, whether the workspace's gate has let go of it. */
  private pollPaid(workspaceId: string): void {
    const clock = this.deps.scheduler ?? realScheduler;
    const ask = async () => {
      this.cancelPaidPoll = null;
      try {
        const usage = await this.deps.api.usage.get(workspaceId);
        if (this.snapshot.dialog?.kind !== "payment_failed" || !this.snapshot.open) return;
        if (usage.billing.gate !== undefined && usage.billing.gate !== "payment_failed") {
          this.deps.refresh(workspaceId);
          this.lifted();
          return;
        }
      } catch {
        // Asked again below.
      }
      if (this.snapshot.dialog?.kind === "payment_failed" && this.snapshot.open) {
        this.cancelPaidPoll = clock.after(PAID_POLL_MS, ask);
      }
    };
    this.cancelPaidPoll = clock.after(PAID_POLL_MS, ask);
  }

  private stopWatching(): void {
    this.watch?.stop();
    this.watch = null;
    this.cancelPaidPoll?.();
    this.cancelPaidPoll = null;
  }

  private setCard(card: CardStep): void {
    const { dialog } = this.snapshot;
    if (dialog?.kind !== "free_used" && dialog?.kind !== "add_card") return;
    this.set({ dialog: { kind: dialog.kind, card } });
  }

  private set(patch: Partial<WallSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function dialogFor(reason: BillingReason): WallDialog {
  switch (reason) {
    case "free_used":
      return { kind: "free_used", card: { status: "idle", error: null } };
    case "cap_reached":
      return { kind: "cap_reached", status: "idle", error: null };
    case "payment_failed":
      return { kind: "payment_failed" };
  }
}

function reasonOf(dialog: WallDialog): BillingDialogReason {
  return dialog.kind;
}

/** What a refused card or cap says under the button: the API's sentence, or that it couldn't be reached. */
function refusalWords(error: unknown): string {
  return error instanceof ApiError && error.status !== 0
    ? error.message
    : "Couldn't reach Ponzu. Try again.";
}
