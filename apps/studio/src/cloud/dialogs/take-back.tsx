import { takeBackWords } from "@ponzu/client/model/driver";
import { BlockingDialog, DialogActions, DialogButton } from "./blocking-dialog.tsx";

/**
 * Taking a canvas back from the person's own agent driving it, from the rail toggle's popover:
 * asked first, since the agent's work stops there. `busy` while the API ends the drive.
 */
export function TakeBackDialog({
  agent,
  open,
  busy,
  onCancel,
  onConfirm,
}: {
  /** The driving agent's name, "Claude Code". */
  agent: string;
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const words = takeBackWords({ name: agent });
  return (
    <BlockingDialog open={open} onDismiss={onCancel} title={words.title} body={words.body} confirm>
      <DialogActions>
        <DialogButton tone="raised" onClick={onCancel} disabled={busy}>
          {words.cancel}
        </DialogButton>
        <DialogButton tone="primary" onClick={onConfirm} busy={busy}>
          {words.confirm}
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}
