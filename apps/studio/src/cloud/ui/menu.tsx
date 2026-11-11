/*
 * The product's menus: a trigger's dropdown and a row's context menu share one look. They are
 * shadcn/ui's dropdown-menu and context-menu (dropdown-menu.tsx, context-menu.tsx), with a row's
 * leading mark, its truncating label and its trailing text laid out the same everywhere, and a
 * content width the design gives. Radix gives them their keyboard (arrows, Home and End,
 * typeahead, Escape, focus back to the trigger) and roles.
 */
import { Tick02Icon } from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";
import {
  ContextMenu,
  ContextMenuItem as ContextMenuRow,
  ContextMenuSeparator as ContextMenuRule,
  ContextMenuContent as ContextMenuSurface,
  ContextMenuTrigger as ContextMenuTriggerPart,
} from "./context-menu.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";
import { Icon } from "./icon.tsx";

export const Menu = DropdownMenu;
export const MenuTrigger = DropdownMenuTrigger;
export const MenuGroup = DropdownMenuGroup;
export const MenuRadioGroup = DropdownMenuRadioGroup;

export function MenuContent({
  width,
  style,
  ...props
}: ComponentProps<typeof DropdownMenuContent> & { width: number }) {
  return <DropdownMenuContent style={{ width, ...style }} {...props} />;
}

export function MenuItem({
  leading,
  trailing,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuItem> & { leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <DropdownMenuItem {...props}>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </DropdownMenuItem>
  );
}

/**
 * One choice of several. The chosen one has the wash at rest and a check at its end, and a step
 * more when highlighted, so the highlight still shows on it.
 */
export function MenuRadioItem({
  leading,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuRadioItem> & { leading?: ReactNode }) {
  return (
    <DropdownMenuRadioItem {...props}>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </DropdownMenuRadioItem>
  );
}

/** A checkbox row: a box at its start, and the menu stays open as it is toggled. */
export function MenuCheckboxItem({
  trailing,
  children,
  checked,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuCheckboxItem>, "checked"> & {
  checked: boolean;
  trailing?: ReactNode;
}) {
  return (
    <DropdownMenuCheckboxItem checked={checked} onSelect={(e) => e.preventDefault()} {...props}>
      <Checkbox checked={checked} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </DropdownMenuCheckboxItem>
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

export const MenuLabel = DropdownMenuLabel;

export function MenuSeparator() {
  return <DropdownMenuSeparator />;
}

export const ContextMenuRoot = ContextMenu;
export const ContextMenuTrigger = ContextMenuTriggerPart;

export function ContextMenuContent({
  width,
  style,
  ...props
}: ComponentProps<typeof ContextMenuSurface> & { width: number }) {
  return <ContextMenuSurface style={{ width, ...style }} {...props} />;
}

export function ContextMenuItem({
  leading,
  children,
  ...props
}: ComponentProps<typeof ContextMenuRow> & { leading?: ReactNode }) {
  return (
    <ContextMenuRow {...props}>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextMenuRow>
  );
}

export function ContextMenuSeparator() {
  return <ContextMenuRule />;
}
