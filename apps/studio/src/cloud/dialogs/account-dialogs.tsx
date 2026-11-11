/*
 * Dialogs about the person's own account: their Claude signed out (on send), disconnecting it,
 * and deleting the account.
 */
import { useId, useState } from "react";
import { ClaudeCard, type ClaudeCardProps, canConnect } from "../setup/claude-card.tsx";
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
 * it again, with the setup's own card, and the prompt goes.
 */
export function ClaudeSignedOutDialog({
  open,
  onDismiss,
  card,
}: {
  open: boolean;
  onDismiss: () => void;
  card: ClaudeCardProps;
}) {
  const { state } = card;
  return (
    <BlockingDialog
      open={open}
      onDismiss={onDismiss}
      title="Claude was signed out"
      body="Connect Claude again and Ponzu sends this. Your prompt is saved."
    >
      <div className="mt-0.5 flex flex-col">
        <ClaudeCard {...card} />
      </div>
      {state.mode === "choose" ? null : (
        <DialogActions>
          <DialogButton
            tone="primary"
            onClick={card.onSubmit}
            disabled={!canConnect(state)}
            busy={state.status === "connecting"}
          >
            Connect and send
          </DialogButton>
        </DialogActions>
      )}
    </BlockingDialog>
  );
}

/** Disconnecting Claude stops the person's designs until they connect again: asked first. */
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
      body="Your designs will wait until you connect again. Running turns stop."
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
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  login: string;
  /** The only admin of a team with other members: someone else must be made one first. */
  soleAdmin: boolean;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const id = useId();
  const matches = typed.trim() === login;
  return (
    <BlockingDialog
      open={open}
      onDismiss={onCancel}
      title="Delete your Ponzu account?"
      body="Your designs, threads and settings are deleted. Your repos and pull requests on GitHub are not touched."
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !soleAdmin) onConfirm();
        }}
      >
        <div className="flex flex-col gap-2">
          <DialogLabel htmlFor={id}>{`Type ${login} to confirm`}</DialogLabel>
          <TextField
            id={id}
            mono
            placeholder={login}
            value={typed}
            disabled={soleAdmin || busy}
            onChange={(e) => setTyped(e.target.value)}
          />
          <DialogError>{soleAdmin ? "Make someone else an admin first." : null}</DialogError>
        </div>
        <DialogActions>
          <DialogButton tone="raised" onClick={onCancel} disabled={busy}>
            Cancel
          </DialogButton>
          <DialogButton tone="danger" type="submit" busy={busy} disabled={!matches || soleAdmin}>
            Delete account
          </DialogButton>
        </DialogActions>
      </form>
    </BlockingDialog>
  );
}
