"use client";

import { type ReactNode, useEffect, useState } from "react";

/** The header's sticky shell: marks itself `data-stuck` once the page has scrolled. */
export function StickyBar({ children }: { children: ReactNode }) {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const check = () => setStuck(window.scrollY > 8);
    check();
    window.addEventListener("scroll", check, { passive: true });
    return () => window.removeEventListener("scroll", check);
  }, []);
  return (
    <nav className="nav sticky top-0 z-50" data-stuck={stuck || undefined}>
      <div className="nav-bar flex items-center justify-between">{children}</div>
    </nav>
  );
}
