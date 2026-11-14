/*
 * The billing walls a send can meet, each the next step and never a lock: the month's free
 * credits are used up and there is no card, the month's cap is reached, or the last payment
 * didn't go through. Someone who can't pay (a team's member) is told who can, and their prompt is
 * kept. Settings' "Add a card" is the first wall's form with no prompt held.
 *
 * The card goes in on Stripe's Checkout page in the browser, not in fields here: Stripe's card
 * fields refuse a page that isn't https, and the studio is served from ponzu-studio://app (the
 * billing plan's departure from the mockup's inline fields). The dialog keeps the cap and its
 * one button, and waits while the browser is open.
 */
import { type ReactNode, useId, useState } from "react";
import { longDate, nextCap, parseCap } from "../settings/billing.ts";
import { TextField } from "../ui/field.tsx";
import {
  BlockingDialog,
  DialogActions,
  DialogButton,
  DialogError,
  DialogLabel,
} from "./blocking-dialog.tsx";

/** Sending the held prompt after the cap is saved. */
export type WallStatus = "idle" | "submitting";

/**
 * Adding a card: the button, Stripe's page being asked for, or the browser open on it until the
 * card comes back.
 */
export type CardStatus = "idle" | "opening" | "waiting";

export interface FreeCreditsDialogProps {
  open: boolean;
  onDismiss: () => void;
  /** The workspace that pays: its name says whose credits, to someone who can't add a card. */
  workspaceName: string;
  /** A team's admin, or the person in their own workspace. */
  canAddCard: boolean;
  /** What the cap starts at: $100. */
  defaultCapUsd: number;
  status: CardStatus;
  /** Why the last try came to nothing: the card wasn't added, or Stripe couldn't be reached. */
  error: string | null;
  /** Open Stripe's page with the cap; the prompt sends once the card is added. */
  onSubmit: (capUsd: number) => void;
  /** Stop waiting on the browser; the prompt stays held. */
  onCancel: () => void;
}

/**
 * The month's free credits are used up and the workspace has no card: add one, with the monthly
 * cap, and the prompt is sent.
 */
export function FreeCreditsDialog(props: FreeCreditsDialogProps) {
  const { open, onDismiss, workspaceName, canAddCard } = props;
  if (!canAddCard) {
    return (
      <AskAnAdmin
        open={open}
        onDismiss={onDismiss}
        title={`${workspaceName} has used this month's free credits`}
        body="Ask an admin to add a card. Your prompt is saved."
      />
    );
  }
  return (
    <BlockingDialog
      open={open}
      onDismiss={onDismiss}
      title="You've used this month's free credits"
      body={
        props.status === "waiting"
          ? "Finish adding your card in your browser. Your prompt sends once it's added."
          : "Add a card to keep going. You only pay for what you use."
      }
    >
      <CardForm
        defaultCapUsd={props.defaultCapUsd}
        status={props.status}
        error={props.error}
        submitLabel="Add card and continue"
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
      />
    </BlockingDialog>
  );
}

export interface AddCardDialogProps {
  open: boolean;
  onDismiss: () => void;
  defaultCapUsd: number;
  status: CardStatus;
  error: string | null;
  onSubmit: (capUsd: number) => void;
  onCancel: () => void;
}

/** Settings' "Add a card", and a canvas's line: the card and the cap, with nothing held. */
export function AddCardDialog(props: AddCardDialogProps) {
  return (
    <BlockingDialog
      open={props.open}
      onDismiss={props.onDismiss}
      title="Add a card"
      body={
        props.status === "waiting"
          ? "Finish adding your card in your browser."
          : "Ponzu bills this workspace each month for what passes its free credits."
      }
    >
      <CardForm
        defaultCapUsd={props.defaultCapUsd}
        status={props.status}
        error={props.error}
        submitLabel="Add card"
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
      />
    </BlockingDialog>
  );
}

export interface CapReachedDialogProps {
  open: boolean;
  onDismiss: () => void;
  workspaceName: string;
  canRaise: boolean;
  capUsd: number;
  /** Billed this month, which the new cap can't go below. */
  billedUsd: number;
  /** When the cap resets by itself. */
  periodEnd: string;
  status: WallStatus;
  error: string | null;
  /** Save the new cap, then send the held prompt. */
  onSubmit: (capUsd: number) => void;
}

/** The workspace has reached its monthly cap: raise it and the prompt is sent, or wait. */
export function CapReachedDialog(props: CapReachedDialogProps) {
  const { open, onDismiss, workspaceName, canRaise } = props;
  if (!canRaise) {
    return (
      <AskAnAdmin
        open={open}
        onDismiss={onDismiss}
        title={`${workspaceName} has reached this month's cap`}
        body="Ask an admin to raise it. Your prompt is saved."
      />
    );
  }
  return (
    <BlockingDialog
      open={open}
      onDismiss={onDismiss}
      title="You've reached this month's cap"
      body={`Raise the cap to keep going, or wait until it resets on ${longDate(props.periodEnd)}.`}
    >
      <CapForm
        initialCap={nextCap(props.capUsd)}
        billed={props.billedUsd}
        busy={props.status === "submitting"}
        error={props.error}
        submitLabel="Raise cap and continue"
        onSubmit={props.onSubmit}
      />
    </BlockingDialog>
  );
}

export interface PaymentFailedDialogProps {
  open: boolean;
  onDismiss: () => void;
  workspaceName: string;
  /** An admin, who can pay it. */
  canPay: boolean;
  /** Opens Stripe's page for the invoice; the dialog stays until it is paid or dismissed. */
  onPay: () => void;
}

/** The workspace's last payment didn't go through and its grace is over: pay it, and the prompt sends. */
export function PaymentFailedDialog(props: PaymentFailedDialogProps) {
  const { open, onDismiss, workspaceName, canPay } = props;
  if (!canPay) {
    return (
      <AskAnAdmin
        open={open}
        onDismiss={onDismiss}
        title={`${workspaceName}'s last payment didn't go through`}
        body="Ask an admin to pay the invoice. Your prompt is saved."
      />
    );
  }
  return (
    <BlockingDialog
      open={open}
      onDismiss={onDismiss}
      title="Your last payment didn't go through"
      body="Pay the invoice to keep going. Your prompt is saved."
    >
      <DialogActions>
        <DialogButton tone="raised" onClick={onDismiss}>
          Not now
        </DialogButton>
        <DialogButton tone="primary" onClick={props.onPay}>
          Pay invoice
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}

/** The cap and the one button that opens Stripe's page; while it is open, the wait and Cancel. */
function CardForm({
  defaultCapUsd,
  status,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  defaultCapUsd: number;
  status: CardStatus;
  error: string | null;
  submitLabel: string;
  onSubmit: (capUsd: number) => void;
  onCancel: () => void;
}) {
  const waiting = status === "waiting";
  return (
    <CapForm
      initialCap={defaultCapUsd}
      billed={0}
      busy={status !== "idle"}
      error={error}
      submitLabel={waiting ? "Waiting for your card" : submitLabel}
      onSubmit={onSubmit}
      before={
        waiting ? (
          <DialogButton tone="raised" onClick={onCancel}>
            Cancel
          </DialogButton>
        ) : null
      }
    />
  );
}

function CapForm({
  initialCap,
  billed,
  busy,
  error,
  submitLabel,
  onSubmit,
  before,
}: {
  initialCap: number;
  billed: number;
  /** Saving, or waiting on the browser: the field holds and the button turns. */
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (capUsd: number) => void;
  /** A raised button before the primary one. */
  before?: ReactNode;
}) {
  const [typed, setTyped] = useState(String(initialCap));
  const cap = parseCap(typed, billed);
  const id = useId();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (cap.ok && !busy) onSubmit(cap.usd);
      }}
    >
      <fieldset disabled={busy} className="m-0 mt-0.5 flex flex-col gap-2 border-0 p-0">
        <DialogLabel htmlFor={id}>Monthly spend cap</DialogLabel>
        <TextField
          id={id}
          inputMode="numeric"
          leading={<span className="font-normal text-faint">$</span>}
          invalid={!cap.ok && typed !== ""}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="gap-1"
        />
        <DialogError>{error ?? (cap.ok || typed === "" ? null : cap.error)}</DialogError>
      </fieldset>
      <DialogActions>
        {before}
        <DialogButton tone="primary" type="submit" busy={busy} disabled={!cap.ok}>
          {submitLabel}
        </DialogButton>
      </DialogActions>
    </form>
  );
}

function AskAnAdmin({
  open,
  onDismiss,
  title,
  body,
}: {
  open: boolean;
  onDismiss: () => void;
  title: string;
  body: string;
}) {
  return (
    <BlockingDialog open={open} onDismiss={onDismiss} title={title} body={body}>
      <DialogActions>
        <DialogButton tone="raised" onClick={onDismiss}>
          Not now
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}
