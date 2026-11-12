/*
 * shadcn/ui's tabs, themed with our tokens as the mockup's page tabs: 28 tall, the active one
 * raised. The arrows move between tabs (and Home and End to the ends) without opening them;
 * Return or Space opens one. No tab may be active (the pull request tab is open): give `value`
 * an empty string and the Tab key lands on the first. Tabs that switch something other than a
 * `TabsContent` (the page tabs open a page) take `panels={false}`, so no tab names a panel that
 * isn't there in `aria-controls`.
 */
import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "./cn.ts";

const Panels = React.createContext(true);

function Tabs({
  activationMode = "manual",
  panels = true,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root> & { panels?: boolean }) {
  return (
    <Panels.Provider value={panels}>
      <TabsPrimitive.Root data-slot="tabs" activationMode={activationMode} {...props} />
    </Panels.Provider>
  );
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
  const panels = React.useContext(Panels);
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      // Radix spreads ours after its own, so this takes back the panel it would name.
      {...(panels ? null : { "aria-controls": undefined })}
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
