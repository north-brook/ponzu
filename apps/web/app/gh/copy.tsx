"use client";

import { useState } from "react";
import { Check } from "@/components/icons";

/** A line of code to paste somewhere, and a button that copies it. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard (an insecure origin, or refused): the text is there to select.
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-faint">{label}</span>
      <div className="flex items-start gap-2 rounded-lg bg-chip p-2 pl-3">
        <code className="min-w-0 flex-1 font-mono text-[11.5px]/[18px] break-all whitespace-pre-wrap text-text select-all">
          {value}
        </code>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-muted hover:text-ink"
          onClick={copy}
        >
          {copied ? <Check /> : null}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
