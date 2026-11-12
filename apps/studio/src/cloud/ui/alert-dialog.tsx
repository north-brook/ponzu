/*
 * shadcn/ui's alert-dialog, themed with our tokens and shaped like dialog.tsx (the dim centres
 * the surface): a question that must be answered, such as disconnecting Claude or deleting the
 * account. It is announced as an alert dialog; unlike shadcn's, a click on the dim still leaves
 * it, as every dialog in the app does, so it behaves as the mockup's other dialogs.
 */
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type * as React from "react";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { type Dim, dimClass, overlayClass, surfaceClass } from "./dialog.tsx";

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(overlayClass, className)}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  dim = "dialog",
  onDismiss,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  dim?: Dim;
  /** A click on the dim, around the surface. */
  onDismiss?: () => void;
}) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay
        className={dimClass(dim)}
        onClick={(e) => {
          if (e.target === e.currentTarget) onDismiss?.();
        }}
      >
        <AlertDialogPrimitive.Content
          data-slot="alert-dialog-content"
          className={cn(surfaceClass, className)}
          {...props}
        />
      </AlertDialogOverlay>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("mt-1 flex items-center gap-2.5", className)}
      {...props}
    />
  );
}

/** Its name. Unstyled: each surface draws its own heading (or none, and hides this one). */
function AlertDialogTitle({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" {...props} />;
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("m-0 text-13 text-muted leading-[1.55]", className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant = "primary",
  size = "dialog",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} className={className} asChild>
      <AlertDialogPrimitive.Action data-slot="alert-dialog-action" {...props} />
    </Button>
  );
}

function AlertDialogCancel({
  className,
  variant = "raised",
  size = "dialog",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} className={className} asChild>
      <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" {...props} />
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
