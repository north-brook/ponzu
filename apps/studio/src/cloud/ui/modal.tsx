import { Dialog } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "./cn.ts";
import { TipProvider } from "./tooltip.tsx";

/**
 * A surface over the whole window, which stays visible and dimmed behind it, centred in the
 * window. Radix gives it its keyboard: focus moves in and stays in, Escape closes it, focus goes
 * back to what opened it. A click on the dim closes it too. A field marked `data-keeps-escape`
 * keeps Escape for itself, to cancel its edit.
 *
 * `dim` is whose: Settings dims a little more than a dialog that blocks a send, as the design
 * draws them.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  dim,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Its accessible name. Shown by the content itself, so it is read here and not drawn. */
  title: string;
  dim: "settings" | "dialog";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-40 grid place-items-center data-[state=open]:animate-[tip-in_var(--dur-pop)_ease-out]",
            dim === "settings" ? "bg-dim" : "bg-dim-dialog",
          )}
        >
          <Dialog.Content
            aria-describedby={undefined}
            // Focus starts on the surface itself, so nothing shows a ring until the person moves
            // it, unless a field inside asked for it (the code to paste, the card number).
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              const content = e.currentTarget as HTMLElement;
              if (!content.contains(document.activeElement)) content.focus();
            }}
            // A field that is being edited takes Escape for itself: it cancels the edit.
            onEscapeKeyDown={(e) => {
              if ((e.target as Element | null)?.closest?.("[data-keeps-escape]"))
                e.preventDefault();
            }}
            className={cn(
              "pop flex overflow-hidden rounded-16 bg-surface text-ink shadow-pop outline-none",
              className,
            )}
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            {/* Its own, so its tips work wherever the modal is mounted. */}
            <TipProvider>{children}</TipProvider>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
