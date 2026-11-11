/*
 * shadcn/ui's dropdown-menu, themed with our tokens: a 12-round surface with the pop shadow, rows
 * 32 tall with the hover wash when highlighted. Radix gives it its keyboard (arrows, Home and
 * End, typeahead, Escape, focus back to the trigger) and roles. The product's menus use the
 * names in menu.tsx, which add a row's leading mark and trailing text.
 */
import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";

/** The surface every menu shares, the dropdown's and a row's context menu. */
export const menuContentClass =
  "pop z-50 flex max-h-(--radix-popper-available-height) flex-col overflow-y-auto rounded-12 bg-surface p-1.5 text-ink shadow-pop outline-none";

/** A row: 32 tall, its leading mark 9px before the label, the hover wash when highlighted. */
export const menuItemClass =
  "flex h-8 shrink-0 cursor-default select-none items-center gap-[9px] rounded-7 px-2 text-13 outline-none data-[disabled]:opacity-35 data-[highlighted]:bg-hover data-[variant=destructive]:text-danger";

/** The chosen one of several has the wash at rest, and a step more when highlighted. */
export const menuRadioItemClass =
  "data-[state=checked]:bg-hover data-[state=checked]:data-[highlighted]:bg-press";

export const menuLabelClass = "px-2 pt-1.5 pb-1 font-medium text-11 text-faint";

export const menuSeparatorClass = "mx-1 my-[5px] h-px shrink-0 bg-rule";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        collisionPadding={collisionPadding}
        className={cn(menuContentClass, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(menuItemClass, "data-[inset]:pl-[30px]", className)}
      {...props}
    />
  );
}

/** A checkbox row. What marks it checked is the caller's (menu.tsx draws a box at its start). */
function DropdownMenuCheckboxItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(menuItemClass, className)}
      {...props}
    />
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/** One choice of several: the chosen one has the wash at rest and a check at its end. */
function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItemClass, menuRadioItemClass, className)}
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator>
        <Icon icon={Tick02Icon} size={14} stroke={2.2} />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(menuLabelClass, "data-[inset]:pl-[30px]", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(menuSeparatorClass, className)}
      {...props}
    />
  );
}

/** A row's shortcut, quiet at its end: "⌘,". */
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto text-11 text-faint", className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(menuItemClass, "data-[inset]:pl-[30px] data-[state=open]:bg-hover", className)}
      {...props}
    >
      {children}
      <Icon icon={ArrowRight01Icon} size={12} stroke={2} className="ml-auto text-faint" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        data-slot="dropdown-menu-sub-content"
        collisionPadding={collisionPadding}
        className={cn(menuContentClass, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
