/*
 * shadcn/ui's resizable (react-resizable-panels), themed with our tokens. The handle is the
 * gutter between two panes, and all of it is the grab area: the column-resize cursor over it, a
 * quiet 2px line in its middle once the pointer rests there (`--dur-linger`, so sweeping across
 * it shows nothing), stronger while held, and the focus ring for the keyboard. shadcn's grip
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

function ResizableHandle({ className, ...props }: ResizablePrimitive.SeparatorProps) {
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
          "pointer-events-none absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2 rounded-pill",
          "transition-[background-color,box-shadow] duration-(--dur-hover) ease-out",
          "group-hover/handle:bg-dry group-hover/handle:delay-(--dur-linger)",
          "group-data-[separator=active]/handle:bg-icon-soft group-data-[separator=active]/handle:delay-0",
          "group-focus-visible/handle:bg-icon-soft group-focus-visible/handle:shadow-focus group-focus-visible/handle:delay-0",
          "group-data-[separator=disabled]/handle:hidden",
        )}
      />
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
