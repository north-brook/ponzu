/*
 * The two billing walls a send can meet, each the next step and never a lock: the month's free
 * credits are used up and there is no card, or the month's cap is reached. Someone who can't pay
 * (a team's member) is told who can, and their prompt is kept.
 */
import { CreditCardIcon } from "@hugeicons/core-free-icons";
import { type ReactNode, useId, useState } from "react";
import { longDate, nextCap, parseCap } from "../settings/billing.ts";
import { cn } from "../ui/cn.ts";
import { TextField } from "../ui/field.tsx";
import { Icon } from "../ui/icon.tsx";
import {
  BlockingDialog,
  DialogActions,
  DialogButton,
  DialogError,
  DialogLabel,
} from "./blocking-dialog.tsx";

/** Sending the held prompt after the card or the cap is saved. */
export type WallStatus = "idle" | "submitting";

export interface FreeCreditsDialogProps {
  open: boolean;
  onDismiss: () => void;
  /** The workspace that pays: its name says whose credits, to someone who can't add a card. */
  workspaceName: string;
  /** A team's admin, or the person in their own workspace. */
  canAddCard: boolean;
  /** Stripe's card fields, mounted in CardFields' frames. */
  card: ReactNode;
  /** Stripe says the card fields are filled in. */
  cardComplete: boolean;
  /** What the cap starts at: $100. */
  defaultCapUsd: number;
  status: WallStatus;
  /** Stripe's message for a declined or invalid card. */
  error: string | null;
  /** Save the card and the cap, then send the held prompt. */
  onSubmit: (capUsd: number) => void;
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
      body="Add a card to keep going. You only pay for what you use."
    >
      <CapForm
        initialCap={props.defaultCapUsd}
        billed={0}
        status={props.status}
        error={props.error}
        ready={props.cardComplete}
        submitLabel="Add card and continue"
        onSubmit={props.onSubmit}
      >
        {props.card}
      </CapForm>
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
        status={props.status}
        error={props.error}
        ready
        submitLabel="Raise cap and continue"
        onSubmit={props.onSubmit}
      />
    </BlockingDialog>
  );
}

/** Stripe's card fields, in frames styled as our own fields: number, then expiry and CVC. */
export function CardFields({
  number,
  expiry,
  cvc,
}: {
  number: ReactNode;
  expiry: ReactNode;
  cvc: ReactNode;
}) {
  const frame =
    "flex h-10 min-w-0 items-center gap-2.5 rounded-9 bg-surface px-3 text-13 text-faint shadow-field focus-within:shadow-field-focus";
  return (
    <>
      <div className={frame}>
        <Icon icon={CreditCardIcon} step="inline" className="shrink-0 text-icon-soft" />
        <div className="min-w-0 flex-1">{number}</div>
      </div>
      <div className="flex gap-2">
        <div className={cn(frame, "flex-1")}>{expiry}</div>
        <div className={cn(frame, "flex-1")}>{cvc}</div>
      </div>
    </>
  );
}

function CapForm({
  initialCap,
  billed,
  status,
  error,
  ready,
  submitLabel,
  onSubmit,
  children,
}: {
  initialCap: number;
  billed: number;
  status: WallStatus;
  error: string | null;
  /** What else must be filled in first: the card. */
  ready: boolean;
  submitLabel: string;
  onSubmit: (capUsd: number) => void;
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState(String(initialCap));
  const cap = parseCap(typed, billed);
  const id = useId();
  const submitting = status === "submitting";
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (cap.ok && ready && !submitting) onSubmit(cap.usd);
      }}
    >
      <fieldset disabled={submitting} className="m-0 mt-0.5 flex flex-col gap-2 border-0 p-0">
        {children}
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
        <DialogButton tone="primary" type="submit" busy={submitting} disabled={!cap.ok || !ready}>
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
