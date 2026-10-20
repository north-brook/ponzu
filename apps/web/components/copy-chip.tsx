"use client";

import { useEffect, useRef, useState } from "react";

export function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1200);
  }

  return (
    <>
      <button
        type="button"
        title="Copy"
        onClick={copy}
        className="cursor-copy rounded-full border-0 bg-chip px-[22px] py-4 font-mono text-sm/[18px] text-text"
      >
        {text}
      </button>
      <div
        role="status"
        aria-live="polite"
        className={`pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 rounded-[10px] bg-ink px-4 py-2.5 text-sm text-ground transition duration-200 ${copied ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0"}`}
      >
        {copied ? "Copied" : ""}
      </div>
    </>
  );
}
