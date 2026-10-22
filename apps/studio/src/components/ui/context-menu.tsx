import { ContextMenu as MenuPrimitive } from "radix-ui";
import type * as React from "react";
import { menuContent, menuItem, menuSeparator } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const ContextMenu = MenuPrimitive.Root;
const ContextMenuTrigger = MenuPrimitive.Trigger;

function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Content>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(menuContent, className)}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof MenuPrimitive.Item>) {
  return (
    <MenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(menuItem, className)}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(menuSeparator, className)} {...props} />;
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
