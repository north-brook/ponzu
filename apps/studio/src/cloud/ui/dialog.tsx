/*
 * shadcn/ui's dialog, themed with our tokens. One change of shape: the dim holds the surface and
 * centres it (a grid), where shadcn's places it at 50% and translates it back by half, which can
 * land it on a half pixel and blur it. A click on the dim is a click outside, so it closes.
 * There is no close button: the design's surfaces carry their own.
 */
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "./cn.ts";

/** The dim behind a surface, and the surface: shared with alert-dialog.tsx. */
export const overlayClass =
  "fixed inset-0 z-40 grid place-items-center data-[state=open]:animate-[tip-in_var(--dur-pop)_ease-out]";
export const surfaceClass =
  "pop flex overflow-hidden rounded-16 bg-surface text-ink shadow-pop outline-none";

/** Whose dim: Settings dims a little more than a dialog that blocks a send. */
export type Dim = "settings" | "dialog";
export const dimClass = (dim: Dim) => (dim === "settings" ? "bg-dim" : "bg-dim-dialog");

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(overlayClass, className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  dim = "dialog",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { dim?: Dim }) {
  return (
    <DialogPortal>
      <DialogOverlay className={dimClass(dim)}>
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(surfaceClass, className)}
          {...props}
        />
      </DialogOverlay>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-3", className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("mt-1 flex items-center gap-2.5", className)}
      {...props}
    />
  );
}

/** Its name. Unstyled: each surface draws its own heading (or none, and hides this one). */
function DialogTitle({ ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" {...props} />;
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("m-0 text-13 text-muted leading-[1.55]", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
