"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * A code block that never scrolls. When a line is wider than the block, the right edge fades out
 * instead of showing a scrollbar; a block that fits is left as it is.
 */
export function CodeWell({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The fade masks the text, not the block, so its background and border stay whole.
  return (
    <pre ref={ref} className={`code-well ${className}`} data-overflows={overflows || undefined}>
      <span className="code-well-fade">{children}</span>
    </pre>
  );
}
