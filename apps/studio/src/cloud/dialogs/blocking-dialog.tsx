import type { ComponentProps, ReactNode } from "react";
import { Waiting } from "../setup/step.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { DialogFooter } from "../ui/dialog.tsx";
import { FieldError, FieldLabel } from "../ui/field.tsx";
import { Slice } from "../ui/marks.tsx";
import { Modal } from "../ui/modal.tsx";

/**
 * What a send needs before it can go, as the next step rather than a wall: a dimmed, centred
 * dialog with the slice, a title, a line, and what to do. Escape or a click on the dim leaves
 * it; the prompt stays in the composer and nothing is sent. `confirm` makes it a question that
 * must be answered (Disconnect Claude?), announced as an alert dialog.
 */
export function BlockingDialog({
  open,
  onDismiss,
  title,
  body,
  wide = false,
  confirm = false,
  children,
}: {
  open: boolean;
  onDismiss: () => void;
  title: string;
  body: string;
  /** 520 rather than 420: room for the setup's 480-wide Claude card as it is drawn there. */
  wide?: boolean;
  confirm?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? undefined : onDismiss())}
      title={title}
      dim="dialog"
      alert={confirm}
      className={cn("flex-col", wide ? "w-[520px]" : "w-[420px]")}
    >
      <div className="flex flex-col gap-3 px-5 pt-[22px] pb-[18px]">
        <Slice size={26} className="text-ink" />
        <h2 className="m-0 font-display font-semibold text-18 text-ink leading-[1.2] tracking-[-0.01em]">
          {title}
        </h2>
        <p className="m-0 text-13 text-muted leading-[1.55]">{body}</p>
        {children}
      </div>
    </Modal>
  );
}

/** The dialog's buttons, side by side across its width. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <DialogFooter>{children}</DialogFooter>;
}

/** A dialog's button: full width, 36 tall. `busy` keeps its label with the turning slice before it. */
export function DialogButton({
  tone,
  busy = false,
  disabled,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  tone: "primary" | "raised" | "danger";
  busy?: boolean;
}) {
  return (
    <Button
      variant={tone}
      size="dialog"
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={cn(busy && "disabled:opacity-100", className)}
      {...props}
    >
      {busy ? <Waiting size={12} /> : null}
      {children}
    </Button>
  );
}

/** A field's label in a dialog: Monthly spend cap. */
export function DialogLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return <FieldLabel htmlFor={htmlFor}>{children}</FieldLabel>;
}

/** What went wrong, under the fields: Stripe's own words for a declined card. */
export function DialogError({ children }: { children: string | null }) {
  return <FieldError>{children}</FieldError>;
}
