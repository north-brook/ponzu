/*
 * shadcn/ui's resizable (react-resizable-panels), themed with our tokens. The handle is the
 * gutter between two panes, and all of it is the grab area: the column-resize cursor over it, a
 * quiet 2px line once the pointer rests there (`--dur-linger`, so sweeping across it shows
 * nothing), stronger while held or focused from the keyboard. The line runs along one side of
 * the gutter (`line`): the canvas's, where the chrome's divider stands above it. shadcn's grip
 * (`withHandle`) is left out: the window's edges show no handle at rest.
 */
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "./cn.ts";

function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn("flex h-full w-full aria-[orientation=vertical]:flex-col", className)}
      {...props}
    />
  );
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;
}

function ResizableHandle({
  className,
  line = "center",
  ...props
}: ResizablePrimitive.SeparatorProps & {
  /** Where across the handle its line runs. */
  line?: "start" | "center" | "end";
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "group/handle relative cursor-col-resize outline-none data-[separator=disabled]:cursor-auto",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-[2px] rounded-pill",
          line === "start" ? "left-0" : line === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
          "transition-[background-color] duration-(--dur-hover) ease-out",
          "group-hover/handle:bg-dry group-hover/handle:delay-(--dur-linger)",
          "group-data-[separator=active]/handle:bg-icon-soft group-data-[separator=active]/handle:delay-0",
          // The keyboard's focus, as the focus ring's own colour: not after a click
          // (`data-quiet-focus`, as `focus-ring`).
          "group-[:focus-visible:not([data-quiet-focus])]/handle:bg-icon-soft group-[:focus-visible:not([data-quiet-focus])]/handle:delay-0",
          "group-data-[separator=disabled]/handle:hidden",
        )}
      />
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
