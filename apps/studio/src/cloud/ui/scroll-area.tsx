import { type ComponentProps, useLayoutEffect, useRef, useState } from "react";
import { cn } from "./cn.ts";

const FADE = 16;

/**
 * A region that scrolls on one axis and fades out at an edge with more beyond it, so a list cut
 * short reads as cut short. Nothing fades while everything fits.
 */
export function ScrollArea({
  axis = "y",
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & { axis?: "x" | "y" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const offset = axis === "y" ? el.scrollTop : el.scrollLeft;
    const room = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    const next = { start: offset > 1, end: offset < room - 1 };
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  };
  const latest = useRef(measure);
  latest.current = measure;

  // Content changes with renders; the box changes with the window.
  useLayoutEffect(() => latest.current());
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => latest.current();
    el.addEventListener("scroll", onChange, { passive: true });
    const observer = new ResizeObserver(onChange);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", onChange);
      observer.disconnect();
    };
  }, []);

  const direction = axis === "y" ? "to bottom" : "to right";
  const mask =
    edges.start || edges.end
      ? `linear-gradient(${direction}, ${edges.start ? "transparent" : "black"}, black ${FADE}px, black calc(100% - ${FADE}px), ${edges.end ? "transparent" : "black"})`
      : undefined;

  return (
    <div
      ref={ref}
      className={cn(
        "min-h-0 [scrollbar-color:var(--c-dry)_transparent] [scrollbar-width:thin]",
        axis === "y"
          ? "overflow-y-auto overflow-x-hidden"
          : "overflow-x-auto overflow-y-hidden [scrollbar-width:none]",
        className,
      )}
      style={{ ...style, maskImage: mask, WebkitMaskImage: mask }}
      {...props}
    >
      {children}
    </div>
  );
}
