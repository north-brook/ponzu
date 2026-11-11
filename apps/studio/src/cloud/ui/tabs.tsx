/*
 * shadcn/ui's tabs, themed with our tokens as the design's page tabs: 28 tall, the active one
 * raised. The arrows move between tabs (and Home and End to the ends) without opening them;
 * Return or Space opens one. No tab may be active (the pull request tab is open): give `value`
 * an empty string and the Tab key lands on the first.
 */
import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "./cn.ts";

function Tabs({
  activationMode = "manual",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" activationMode={activationMode} {...props} />;
}

function TabsList({
  className,
  loop = false,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      loop={loop}
      className={cn("flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "app-no-drag flex h-7 shrink-0 cursor-default select-none items-center gap-1.5 whitespace-nowrap rounded-7 px-2.5 text-13 outline-none transition-colors duration-(--dur-hover) focus-ring",
        "data-[state=active]:bg-raised data-[state=active]:font-medium data-[state=active]:text-ink data-[state=active]:shadow-raised",
        "data-[state=inactive]:text-muted data-[state=inactive]:active:bg-press data-[state=inactive]:hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
