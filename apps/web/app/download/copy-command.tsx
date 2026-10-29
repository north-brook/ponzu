"use client";

import { useEffect, useState } from "react";
import { Check, CopyIcon, Terminal } from "@/components/icons";

const COMMAND = "bunx ponzu serve";

/** The CLI, for any machine with Bun: the card copies its command. */
export function CopyCommand() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      className="flex items-center gap-4 rounded-[18px] px-6 py-5 text-left shadow-[inset_0_0_0_1px_var(--rule)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--outline)]"
      onClick={() => {
        void navigator.clipboard?.writeText(COMMAND).then(() => setCopied(true));
      }}
    >
      <span className="text-[22px] text-ink">
        <Terminal />
      </span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-ink">Terminal</span>
        <span className="font-mono text-[13px] text-faint">{COMMAND}</span>
      </span>
      <span className="flex items-center gap-1.5 text-[13px] text-muted" aria-live="polite">
        {copied ? (
          <Check className="size-3.5 shrink-0 fill-none stroke-current text-ok" />
        ) : (
          <CopyIcon />
        )}
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
