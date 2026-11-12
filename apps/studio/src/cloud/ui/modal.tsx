import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "./alert-dialog.tsx";
import { Dialog, DialogContent, DialogTitle, type Dim } from "./dialog.tsx";
import { TipProvider } from "./tooltip.tsx";

/**
 * A surface over the whole window, which stays visible and dimmed behind it, centred in the
 * window: shadcn/ui's dialog (dialog.tsx), or its alert-dialog for a question that must be
 * answered (`alert`). Radix gives it its keyboard: focus moves in and stays in, Escape closes
 * it, focus goes back to what opened it. A click on the dim closes it too. A field marked
 * `data-keeps-escape` keeps Escape for itself, to cancel its edit.
 *
 * `dim` is whose: Settings dims a little more than a dialog that blocks a send, as the mockup
 * draws them.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  dim,
  alert = false,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Its accessible name. Shown by the content itself, so it is read here and not drawn. */
  title: string;
  dim: Dim;
  /** A confirmation: announced as an alert dialog. */
  alert?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // What had the keyboard as it opened. Radix gives focus back to a dialog's trigger, and these
  // open without one (⌘, a menu item, an answer from the API), so it is given back here.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) {
      const at = document.activeElement;
      opener.current = at instanceof HTMLElement && at !== document.body ? at : null;
    }
  }, [open]);
  const content = {
    dim,
    className,
    "aria-describedby": undefined,
    onCloseAutoFocus: (e: Event) => {
      const back = opener.current;
      opener.current = null;
      // Gone with what it was in (a menu's item): Radix's own way, then.
      if (!back?.isConnected) return;
      e.preventDefault();
      back.focus({ preventScroll: true });
    },
    // Focus starts on the surface itself, so nothing shows a ring until the person moves it,
    // unless a field inside asked for it (the code to paste, the card number).
    onOpenAutoFocus: (e: Event) => {
      e.preventDefault();
      const surface = e.currentTarget as HTMLElement;
      if (!surface.contains(document.activeElement)) surface.focus();
    },
    // A field that is being edited takes Escape for itself: it cancels the edit.
    onEscapeKeyDown: (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-keeps-escape]")) e.preventDefault();
    },
  } satisfies ComponentProps<typeof DialogContent>;
  // Its own, so its tips work wherever the modal is mounted.
  const body = <TipProvider>{children}</TipProvider>;

  if (alert) {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent {...content} onDismiss={() => onOpenChange(false)}>
          <AlertDialogTitle className="sr-only">{title}</AlertDialogTitle>
          {body}
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...content}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
}
