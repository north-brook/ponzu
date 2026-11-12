/*
 * Dialogs about the person's own account: their Claude signed out (on send, or from a canvas
 * waiting on it), getting the iPhone app, disconnecting Claude, and deleting the account.
 */
import { useEffect, useId, useState } from "react";
import { ClaudeCard, type ClaudeCardProps, canConnect } from "../setup/claude-card.tsx";
import { IphoneCard } from "../setup/iphone-step.tsx";
import { TextField } from "../ui/field.tsx";
import {
  BlockingDialog,
  DialogActions,
  DialogButton,
  DialogError,
  DialogLabel,
} from "./blocking-dialog.tsx";

/**
 * The person's Claude is signed out (its year ran out, or it was revoked) and they sent: connect
 * it again, with the setup's own card, and the prompt goes. From an open canvas that waits on
 * it (`resume`), connecting is all it takes for the canvas to pick up again.
 */
export function ClaudeSignedOutDialog({
  open,
  onDismiss,
  card,
  connected = true,
  expired = false,
  resume = false,
}: {
  open: boolean;
  onDismiss: () => void;
  card: ClaudeCardProps;
  /** False for someone with no Claude at all: it asks to connect, not to reconnect. */
  connected?: boolean;
  /** Its sign-in ran out, rather than being revoked: said as the mockup's strip says it. */
  expired?: boolean;
  /** Opened from a canvas waiting on the person's Claude, not from a send. */
  resume?: boolean;
}) {
  const { state } = card;
  const then = resume
    ? "and this canvas picks up where it waited."
    : "and Ponzu sends this. Your prompt is saved.";
  const title = !connected
    ? "Connect Claude"
    : expired
      ? "Your Claude sign-in ran out"
      : "Claude was signed out";
  return (
    <BlockingDialog
      open={open}
      onDismiss={onDismiss}
      title={title}
      body={
        connected
          ? `${expired ? "Sign in to Claude again" : "Connect Claude again"} ${then}`
          : `Claude Code does the work, on your own plan. Connect it ${then}`
      }
      wide
    >
      <div className="mt-0.5 flex flex-col">
        <ClaudeCard {...card} />
      </div>
      <DialogActions>
        <DialogButton tone="raised" onClick={onDismiss}>
          Cancel
        </DialogButton>
        {state.mode === "choose" ? null : (
          <DialogButton
            tone="primary"
            onClick={card.onSubmit}
            disabled={!canConnect(state)}
            busy={state.status === "connecting"}
          >
            {resume ? "Connect" : "Connect and send"}
          </DialogButton>
        )}
      </DialogActions>
    </BlockingDialog>
  );
}

/** Getting Ponzu on an iPhone, from Settings: the guided setup's own card, over the window. */
export function GetIphoneDialog({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  return (
    <BlockingDialog
      open={open}
      onDismiss={onDismiss}
      title="Get Ponzu on your iPhone"
      body="See your canvases live and comment on them from your iPhone."
      wide
    >
      <div className="mt-0.5 flex flex-col">
        <IphoneCard />
      </div>
      <DialogActions>
        <DialogButton tone="raised" onClick={onDismiss}>
          Done
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}

/** Disconnecting Claude stops the person's canvases until they connect again: asked first. */
export function DisconnectClaudeDialog({
  open,
  onCancel,
  onConfirm,
  busy = false,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <BlockingDialog
      open={open}
      onDismiss={onCancel}
      title="Disconnect Claude?"
      confirm
      body="Your canvases will wait until you connect again. Running turns stop."
    >
      <DialogActions>
        <DialogButton tone="raised" onClick={onCancel} disabled={busy}>
          Cancel
        </DialogButton>
        <DialogButton tone="danger" onClick={onConfirm} busy={busy}>
          Disconnect
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}

/**
 * Deleting the account, confirmed by typing the GitHub login. Refused while the person is the
 * only admin of a team that has other people in it.
 */
export function DeleteAccountDialog({
  open,
  onCancel,
  onConfirm,
  login,
  soleAdmin,
  busy = false,
  error = null,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  login: string;
  /**
   * The only admin of a team with other members: someone else must be made one first. With the
   * teams' names, the dialog says which.
   */
  soleAdmin: boolean | string[];
  busy?: boolean;
  /** Why the last try didn't go, when it was something else. */
  error?: string | null;
}) {
  const [typed, setTyped] = useState("");
  // Each opening starts with the field empty.
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const id = useId();
  // GitHub's logins are the same whatever their case.
  const matches = typed.trim().toLowerCase() === login.toLowerCase();
  const blocked = Array.isArray(soleAdmin) ? soleAdmin.length > 0 : soleAdmin;
  return (
    <BlockingDialog
      open={open}
      onDismiss={onCancel}
      title="Delete your Ponzu account?"
      confirm
      body="Your canvases, threads and settings are deleted. Your repos and pull requests on GitHub are not touched."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !blocked) onConfirm();
        }}
      >
        <div className="flex flex-col gap-2">
          <DialogLabel htmlFor={id}>{`Type ${login} to confirm`}</DialogLabel>
          <TextField
            id={id}
            mono
            placeholder={login}
            value={typed}
            disabled={blocked || busy}
            onChange={(e) => setTyped(e.target.value)}
          />
          <DialogError>
            {blocked
              ? Array.isArray(soleAdmin) && soleAdmin.length
                ? `You're the only admin of ${listed(soleAdmin)}. Make someone else an admin first.`
                : "Make someone else an admin first."
              : error}
          </DialogError>
        </div>
        <DialogActions>
          <DialogButton tone="raised" onClick={onCancel} disabled={busy}>
            Cancel
          </DialogButton>
          <DialogButton tone="danger" type="submit" busy={busy} disabled={!matches || blocked}>
            Delete account
          </DialogButton>
        </DialogActions>
      </form>
    </BlockingDialog>
  );
}

/** "North Brook", "North Brook and Lisbon", "A, B and C". */
function listed(names: string[]): string {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
