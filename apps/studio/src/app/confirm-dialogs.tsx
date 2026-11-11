import { BlockingDialog, DialogActions, DialogButton } from "../cloud/dialogs/blocking-dialog.tsx";

/*
 * The open design's confirmations: what can't be taken back, or goes past the repo's rules,
 * is asked first.
 */

/** Deleting a design takes its canvas and thread from everyone. */
export function DeleteDesignDialog({
  name,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <BlockingDialog
      open={open}
      onDismiss={onCancel}
      title={`Delete “${name}”?`}
      body="Its canvas and thread go, for everyone. Its branch and pull request on GitHub stay."
    >
      <DialogActions>
        <DialogButton tone="raised" onClick={onCancel} disabled={busy}>
          Cancel
        </DialogButton>
        <DialogButton tone="danger" onClick={onConfirm} busy={busy}>
          Delete
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}

/**
 * Merging while the repo's rules still want something (a review, a required check): GitHub
 * merges it only for someone its rules let past them, so it is the person's choice to ask.
 */
export function BypassMergeDialog({
  reason,
  onCancel,
  onConfirm,
}: {
  /** What the rules still want, in a sentence; null while there is nothing to confirm. */
  reason: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <BlockingDialog
      open={reason !== null}
      onDismiss={onCancel}
      title="Merge without what the rules want?"
      body={`${reason ?? ""} GitHub merges it anyway only if the repo lets you bypass its rules.`}
    >
      <DialogActions>
        <DialogButton tone="raised" onClick={onCancel}>
          Cancel
        </DialogButton>
        <DialogButton tone="danger" onClick={onConfirm}>
          Merge anyway
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}
