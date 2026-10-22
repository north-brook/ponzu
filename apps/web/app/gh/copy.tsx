"use client";

import { type ReactNode, useState } from "react";
import { Check } from "@/components/icons";

/** Copies `value`, and says so for a moment. A refused clipboard leaves the text to select. */
function useCopy(value: string) {
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
  return [copied, copy] as const;
}

const COPY_ICON =
  "M8 8h13v13H8ZM16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8";

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[1em] shrink-0 fill-none stroke-current"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={COPY_ICON} />
    </svg>
  );
}

/** One command on ink, `$` first, cut short with an ellipsis, and a copy button at its end. */
export function CopyCommand({ value }: { value: string }) {
  const [copied, copy] = useCopy(value);
  return (
    <div className="flex h-11 items-center gap-2.5 rounded-[11px] bg-code pr-1.5 pl-3.5 font-mono text-xs text-code-ink">
      <span aria-hidden="true" className="text-faint select-none">
        $
      </span>
      <code className="min-w-0 flex-1 truncate select-all" title={value}>
        {value}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy command"}
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-[13px] text-code-ink transition-colors hover:bg-white/20"
        onClick={copy}
      >
        {copied ? <Check /> : <CopyIcon />}
      </button>
    </div>
  );
}

/** A quiet pill that copies `value`, labelled by its children. */
export function CopyButton({ value, children }: { value: string; children: ReactNode }) {
  const [copied, copy] = useCopy(value);
  return (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-ground px-3 text-[13px] font-medium text-text shadow-[0_0_0_1px_var(--outline)] transition-colors hover:bg-chip"
      onClick={copy}
    >
      {copied ? <Check /> : <CopyIcon />}
      {copied ? "Copied" : children}
    </button>
  );
}
