import { BlockingDialog, DialogActions, DialogButton } from "./blocking-dialog.tsx";

/** The dialog's words, as docs/cloud.md gives them ("Assets and previews"). */
export const RESET_FILE_LINKS = {
  title: "Reset this canvas's file links?",
  body: "Links to its images and exports stop working, including any you've copied or pasted elsewhere. Everyone who can open the canvas gets the new ones.",
  confirm: "Reset links",
  cancel: "Cancel",
} as const;

/**
 * Resetting a canvas's file links, from Share's foot: its files move to a new address, and every
 * link to the old one stops working, wherever it was copied. Only its owner and the workspace's
 * admins are offered it. `busy` while the API copies the files across.
 */
export function ResetFileLinksDialog({
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <BlockingDialog
      open={open}
      onDismiss={onCancel}
      title={RESET_FILE_LINKS.title}
      body={RESET_FILE_LINKS.body}
      confirm
    >
      <DialogActions>
        <DialogButton tone="raised" onClick={onCancel} disabled={busy}>
          {RESET_FILE_LINKS.cancel}
        </DialogButton>
        <DialogButton tone="danger" onClick={onConfirm} busy={busy}>
          {RESET_FILE_LINKS.confirm}
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}
