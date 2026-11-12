import { useRef } from "react";
import { BlockingDialog, DialogActions, DialogButton } from "../cloud/dialogs/blocking-dialog.tsx";

/*
 * The open canvas's confirmations: what can't be taken back, or goes past the repo's rules,
 * is asked first.
 */

/** Deleting a canvas takes it and its thread from everyone. */
export function DeleteCanvasDialog({
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
      body="The canvas and its thread go, for everyone. Its branch and pull request on GitHub stay."
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
 * Closing the pull request without merging it. Nothing of the work goes: the branch and its
 * commits stay on GitHub and in the canvas, and Create PR opens a new pull request from them.
 */
export function ClosePullRequestDialog({
  number,
  onCancel,
  onConfirm,
}: {
  /** The pull request's number; null while there is nothing to confirm. */
  number: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // The number it asked about stays in the title while the dialog fades out.
  const asked = useRef(number);
  if (number !== null) asked.current = number;
  return (
    <BlockingDialog
      open={number !== null}
      onDismiss={onCancel}
      title={`Close #${asked.current ?? ""} without merging?`}
      body="The branch and its commits stay. Create PR opens a new one later."
    >
      <DialogActions>
        <DialogButton tone="raised" onClick={onCancel}>
          Cancel
        </DialogButton>
        <DialogButton tone="danger" onClick={onConfirm}>
          Close pull request
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
