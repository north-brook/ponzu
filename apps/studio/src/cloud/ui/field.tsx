/*
 * shadcn/ui's field, themed with our tokens: a control with its label, a line under it, and what
 * went wrong. `TextField` is the product's one-line text field, on shadcn's input-group.
 *
 * Only the parts the app uses are here; shadcn's FieldSet, FieldLegend, FieldGroup, FieldTitle
 * and FieldSeparator are for a form of many fields, which the first such form adds
 * (`bun run shadcn add field --diff` shows them).
 */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group.tsx";
import { Label } from "./label.tsx";

function Field({ className, ...props }: ComponentProps<"div">) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: shadcn's shape; a fieldset is FieldSet's, for many fields
    <div
      role="group"
      data-slot="field"
      className={cn("flex flex-col gap-2 data-[disabled=true]:opacity-35", className)}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return <Label data-slot="field-label" className={className} {...props} />;
}

function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("m-0 px-0.5 text-12 text-faint", className)}
      {...props}
    />
  );
}

/** What went wrong, under the fields, read out as it appears. Nothing when there is nothing. */
function FieldError({ className, children, ...props }: ComponentProps<"p">) {
  if (!children) return null;
  return (
    <p
      role="alert"
      data-slot="field-error"
      className={cn("m-0 px-0.5 text-12 text-danger", className)}
      {...props}
    >
      {children}
    </p>
  );
}

/**
 * A one-line text field, 40 tall: an edge at rest, and focused the mockup's soft halo with a yuzu
 * caret (never an ink ring). `invalid` turns the edge danger and keeps the halo. `leading` sits
 * before the text: an icon, or the faint "$" of an amount.
 */
export function TextField({
  invalid = false,
  mono = false,
  compact = false,
  leading,
  trailing,
  className,
  ...props
}: ComponentProps<"input"> & {
  invalid?: boolean;
  mono?: boolean;
  /** 28 tall, for a field inside a row: a secret, the cap. */
  compact?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <InputGroup
      size={compact ? "compact" : "default"}
      className={cn(
        invalid && "shadow-field-error focus-within:shadow-field-error-focus",
        className,
      )}
    >
      {leading ? <InputGroupAddon>{leading}</InputGroupAddon> : null}
      <InputGroupInput
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        className={mono ? "font-mono" : undefined}
        {...props}
      />
      {trailing ? <InputGroupAddon align="inline-end">{trailing}</InputGroupAddon> : null}
    </InputGroup>
  );
}

export { Field, FieldDescription, FieldError, FieldLabel };
