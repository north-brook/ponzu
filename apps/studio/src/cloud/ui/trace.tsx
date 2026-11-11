/*
 * shadcn/ui's Trace (the base of its AI Elements: Chain of Thought, Task, Tool), themed with our
 * tokens: a list of quiet lines, each an icon, a title and a description, one of which may open
 * on what it holds. The thread's folded turn is built on it. Radix's Collapsible gives the
 * trigger its button, `aria-expanded` and `aria-controls`; opening and closing animate the
 * content's height with `fold` (the pane's duration and easing), stilled by reduced motion.
 */
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type * as React from "react";
import { cn } from "./cn.ts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible.tsx";
import { Icon } from "./icon.tsx";

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}
      {...props}
    />
  );
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending";
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex w-fit min-w-0 max-w-full items-center gap-1.5 text-12 text-faint leading-[1.4] transition-colors duration-(--dur-hover) in-[a:hover,button:hover]:text-muted data-[status=error]:text-danger data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer",
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none",
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cn("min-w-0 truncate", className)} {...props} />;
}

function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn("shrink-0 text-dry tabular-nums", className)}
      {...props}
    />
  );
}

function TraceCollapsible({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "asChild" | "open"> &
  (
    | { open?: undefined }
    | {
        open: boolean;
        onOpenChange: NonNullable<React.ComponentProps<typeof Collapsible>["onOpenChange"]>;
      }
  )) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn("flex w-full min-w-0 flex-col", className)}
      {...props}
    />
  );
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CollapsibleTrigger>, "asChild">) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-collapsible-trigger flex w-fit min-w-0 max-w-full cursor-default items-center gap-1 rounded-6 text-left text-faint outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-muted has-[[data-status=error]]:text-danger",
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="transition-transform duration-(--dur-pop) ease-(--ease-out) group-aria-expanded/trace-collapsible-trigger:rotate-90">
        <Icon icon={ArrowRight01Icon} size={11} stroke={2} />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof CollapsibleContent>, "asChild">) {
  return (
    <CollapsibleContent data-slot="trace-collapsible-content" className="fold min-w-0" {...props}>
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          "mt-2 mb-1 ml-[calc(--spacing(2)-1px)] min-w-0 border-rule border-l pr-1 pl-4 text-muted leading-[1.5] [overflow-wrap:anywhere]",
          className,
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
};
