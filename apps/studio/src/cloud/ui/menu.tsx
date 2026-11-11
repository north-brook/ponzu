/*
 * Menus: a trigger's dropdown and a row's context menu share one look. Radix gives them their
 * keyboard (arrows, Home and End, typeahead, Escape, focus back to the trigger) and roles.
 */
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { ContextMenu, DropdownMenu } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";

const contentClass =
  "pop z-50 flex max-h-(--radix-popper-available-height) flex-col overflow-y-auto rounded-12 bg-surface p-1.5 text-ink shadow-pop outline-none";

/** A row: 32 tall, its leading mark 9px before the label, the hover wash when highlighted. */
const itemClass =
  "flex h-8 shrink-0 cursor-default select-none items-center gap-[9px] rounded-7 px-2 text-13 outline-none data-[disabled]:opacity-35 data-[highlighted]:bg-hover";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuContent({
  width,
  className,
  ...props
}: ComponentProps<typeof DropdownMenu.Content> & { width: number }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        collisionPadding={8}
        className={cn(contentClass, className)}
        style={{ width }}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  leading,
  trailing,
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.Item> & { leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <DropdownMenu.Item className={cn(itemClass, className)} {...props}>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </DropdownMenu.Item>
  );
}

/**
 * One choice of several. The chosen one has the wash at rest and a check at its end, and a step
 * more when highlighted, so the highlight still shows on it.
 */
export function MenuRadioItem({
  leading,
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenu.RadioItem> & { leading?: ReactNode }) {
  return (
    <DropdownMenu.RadioItem
      className={cn(
        itemClass,
        "data-[state=checked]:bg-hover data-[state=checked]:data-[highlighted]:bg-press",
        className,
      )}
      {...props}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenu.ItemIndicator>
        <Icon icon={Tick02Icon} size={14} stroke={2.2} />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}

/** A checkbox row: a box at its start, and the menu stays open as it is toggled. */
export function MenuCheckboxItem({
  trailing,
  className,
  children,
  checked,
  onCheckedChange,
  ...props
}: Omit<ComponentProps<typeof DropdownMenu.CheckboxItem>, "checked"> & {
  checked: boolean;
  trailing?: ReactNode;
}) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
      className={cn(itemClass, className)}
      {...props}
    >
      <Checkbox checked={checked} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </DropdownMenu.CheckboxItem>
  );
}

/** A 15px box: ink with a white tick when checked, an empty outline when not. */
export function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-[15px] shrink-0 place-items-center rounded-4",
        checked ? "bg-action text-action-ink" : "shadow-[inset_0_0_0_1px_var(--c-faint)]",
      )}
    >
      {checked ? <Icon icon={Tick02Icon} size={10} stroke={2.8} /> : null}
    </span>
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label
      className={cn("px-2 pt-1.5 pb-1 font-medium text-11 text-faint", className)}
      {...props}
    />
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="mx-1 my-[5px] h-px shrink-0 bg-rule" />;
}

export const ContextMenuRoot = ContextMenu.Root;
export const ContextMenuTrigger = ContextMenu.Trigger;

export function ContextMenuContent({
  width,
  className,
  ...props
}: ComponentProps<typeof ContextMenu.Content> & { width: number }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        collisionPadding={8}
        className={cn(contentClass, className)}
        style={{ width }}
        {...props}
      />
    </ContextMenu.Portal>
  );
}

export function ContextMenuItem({
  leading,
  className,
  children,
  ...props
}: ComponentProps<typeof ContextMenu.Item> & { leading?: ReactNode }) {
  return (
    <ContextMenu.Item className={cn(itemClass, className)} {...props}>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenu.Item>
  );
}

export function ContextMenuSeparator() {
  return <ContextMenu.Separator className="mx-1 my-[5px] h-px shrink-0 bg-rule" />;
}
