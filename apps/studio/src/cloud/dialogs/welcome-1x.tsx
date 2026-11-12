import { BlockingDialog, DialogActions, DialogButton } from "./blocking-dialog.tsx";

/*
 * The welcome a person coming from Ponzu 1.x sees once, over the sign-in screen (the production
 * plan, "Someone on 1.x today"): Ponzu works in the cloud now, and the .design folders 1.x
 * made are still on the computer, which this version doesn't open. One button. The shell decides
 * whether to show it (apps/desktop/src/legacy.ts, `takeWelcome1x`); this only draws it.
 */

export const WELCOME_1X_TITLE = "Ponzu works in the cloud now";
export const WELCOME_1X_BODY =
  "Your canvases, threads and the agent now live in Ponzu Cloud, the same on every Mac and on your iPhone. The .design folders Ponzu 1 made are still on this computer, where you left them; this version doesn't open them.";

export function Welcome1xSheet({ open, onContinue }: { open: boolean; onContinue: () => void }) {
  return (
    <BlockingDialog
      open={open}
      onDismiss={onContinue}
      title={WELCOME_1X_TITLE}
      body={WELCOME_1X_BODY}
    >
      <DialogActions>
        <DialogButton tone="primary" onClick={onContinue}>
          Continue
        </DialogButton>
      </DialogActions>
    </BlockingDialog>
  );
}
