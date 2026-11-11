/*
 * shadcn/ui's command, on cmdk, themed with our tokens: a search field over a list it narrows,
 * which the keyboard drives from the field (arrows, Home and End, Return chooses) while the
 * field keeps focus. With a popover it is shadcn's combobox: the repo picker.
 *
 * Changed from shadcn's: the field is a label, so a click on its icon focuses it, and its rule
 * under it is the caller's; the field and the rows take the menus' one-line metrics (32 tall, the
 * mark 9px before the text, a 16px icon), so a command reads as one of the menus' family;
 * shadcn's CommandDialog (a palette in a dialog) isn't used yet.
 */
import { Search01Icon } from "@hugeicons/core-free-icons";
import { Command as CommandPrimitive } from "cmdk";
import type * as React from "react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "./cn.ts";
import { Icon } from "./icon.tsx";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("flex flex-col text-ink", className)}
      {...props}
    />
  );
}

/**
 * cmdk names the highlighted row for assistive tech only once the keys or pointer move it; the
 * row it opens on (a controlled `value`) is named too, on whichever holds focus (the field, or
 * the list when there is no field), once that row marks itself.
 */
function useNamesOpeningRow(ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.closest("[cmdk-root]");
    if (!el || !root) return;
    const name = () => {
      if (el.hasAttribute("aria-activedescendant")) return;
      const row = root.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
      if (row?.id) el.setAttribute("aria-activedescendant", row.id);
    };
    name();
    const observer = new MutationObserver(name);
    observer.observe(root, { subtree: true, attributeFilter: ["data-selected"] });
    return () => observer.disconnect();
  }, [ref]);
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  const ref = useRef<HTMLInputElement>(null);
  useNamesOpeningRow(ref);
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: cmdk's input inside it is the control
    <label
      data-slot="command-input-wrapper"
      className="flex h-8 shrink-0 items-center gap-[9px] px-2 text-13"
    >
      <Icon icon={Search01Icon} size={16} stroke={1.7} className="text-faint" />
      <CommandPrimitive.Input
        ref={ref}
        data-slot="command-input"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-ink outline-none [caret-color:var(--c-yuzu)] placeholder:text-faint",
          className,
        )}
        {...props}
      />
    </label>
  );
}

/** The rows. With no field above them, give it focus: it takes the keys and names the row. */
function CommandList({
  className,
  ref: given,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  const ref = useRef<HTMLDivElement>(null);
  useNamesOpeningRow(ref);
  return (
    <CommandPrimitive.List
      ref={(el) => {
        ref.current = el;
        if (typeof given === "function") given(el);
        else if (given) given.current = el;
      }}
      data-slot="command-list"
      className={cn("flex flex-col outline-none", className)}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("m-0 flex h-8 items-center px-2 text-13 text-muted", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "flex flex-col [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-0.5 [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-11 [&_[cmdk-group-heading]]:text-faint",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("mx-1 my-[5px] h-px shrink-0 bg-rule", className)}
      {...props}
    />
  );
}

/** A row, 32 tall like a menu's: the hover wash on the one the keyboard or the pointer is on. */
function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "flex h-8 shrink-0 cursor-default select-none items-center gap-[9px] rounded-7 px-2 text-13 data-[disabled=true]:opacity-35 data-[selected=true]:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto text-11 text-faint", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
