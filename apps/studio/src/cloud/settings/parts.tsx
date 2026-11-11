/*
 * What every Settings section is built from, identical wherever it recurs: a labelled section of
 * hairline-ruled rows, a row's two-line label, a raised button, a value picker, an icon action.
 */
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import { Button, IconButton } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import type { IconSvgElement } from "../ui/icon.tsx";
import { Icon } from "../ui/icon.tsx";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu.tsx";

/** A section: its label in small capitals, its rows under a hairline, and a note under them. */
export function Section({
  label,
  note,
  action,
  children,
}: {
  label: string;
  note?: ReactNode;
  /** Beside the label, at the right. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <SectionLabel>{label}</SectionLabel>
        {action}
      </div>
      <div className="flex flex-col border-rule border-t">{children}</div>
      {note ? <p className="m-0 text-12 text-faint leading-[1.5]">{note}</p> : null}
    </section>
  );
}

export function SectionLabel({ className, children }: { className?: string; children: string }) {
  return (
    <span
      className={cn(
        "flex-1 font-semibold text-11 text-faint uppercase tracking-[0.02em]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A row: at least 48 tall, what it is on the left, what to do on the right. */
export function Row({
  leading,
  children,
  trailing,
  className,
}: {
  leading?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center gap-3 border-rule py-1.5 not-last:border-b",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {leading}
        {children}
      </div>
      {trailing}
    </div>
  );
}

/**
 * A row that is one action, pressed anywhere along it: what it does on the left and its icon,
 * at the end, as a row's icon action sits ("Use an API key instead" ›).
 */
export function ActionRow({
  leading,
  children,
  icon,
  onClick,
}: {
  leading?: ReactNode;
  children: ReactNode;
  icon: IconSvgElement;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-12 w-full cursor-default items-center gap-3 border-rule py-1.5 text-left outline-none focus-ring not-last:border-b"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        {leading}
        {children}
      </span>
      <span className="grid size-7 place-items-center text-faint transition-colors duration-(--dur-hover) group-hover:text-muted">
        <Icon icon={icon} size={16} stroke={1.5} />
      </span>
    </button>
  );
}

/** A row's title over its line in faint. */
export function TwoLine({ title, line }: { title: ReactNode; line?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-medium text-13 text-ink">{title}</span>
      {line ? <span className="truncate text-12 text-faint">{line}</span> : null}
    </div>
  );
}

/** A raised button at the end of a row: Sign out, Disconnect, Rebuild. */
export function QuietButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant">) {
  return <Button variant="raised" className={cn("h-7 px-[11px]", className)} {...props} />;
}

/** An icon alone at the end of a row: Change cap, Edit, Manage in Stripe. */
export function RowIcon({
  icon,
  label,
  stroke = 1.5,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  icon: IconSvgElement;
  label: string;
  stroke?: number;
}) {
  return (
    <IconButton label={label} className="size-7 text-faint hover:text-muted" {...props}>
      <Icon icon={icon} size={16} stroke={stroke} />
    </IconButton>
  );
}

/** A choice saved as it is made: the value in ink with a chevron, and no ground at rest. */
export function ValuePicker<T extends string>({
  label,
  value,
  options,
  onChange,
  leading,
}: {
  /** What it sets, for assistive tech: "Model". */
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  leading?: ReactNode;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="quiet"
          aria-label={`${label}: ${current}`}
          className="gap-[5px] pr-1.5 pl-2.5 text-13 text-ink"
        >
          {leading}
          {current}
          <Icon icon={ArrowDown01Icon} size={11} stroke={2.2} className="text-muted" />
        </Button>
      </MenuTrigger>
      <MenuContent width={200} side="bottom" align="end" sideOffset={4}>
        <MenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <MenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** A meter: a 6px track with the share used in ink. */
export function Meter({ value, label }: { value: number | null; label: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> can't be drawn as the design's bar
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      className="block h-1.5 w-full overflow-hidden rounded-pill bg-track"
    >
      <span
        className="block h-full rounded-pill bg-ink transition-[width] duration-(--dur-pane) ease-out"
        style={{ width: `${Math.min(100, value ?? 0)}%` }}
      />
    </span>
  );
}
