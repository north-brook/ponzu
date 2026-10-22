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

/** Commands on ink, a line each, with a copy button in the corner. */
export function CopyBlock({ value }: { value: string }) {
  const [copied, copy] = useCopy(value);
  return (
    <div className="relative rounded-[10px] bg-code py-2.5 pr-9 pl-3 font-mono text-[11.5px]/[1.7] text-code-ink">
      <code className="block break-all whitespace-pre-wrap select-all">
        {value.split("\n").map((line) => (
          <span key={line} className="block pl-[2ch] -indent-[2ch]">
            <span className="text-faint select-none">$ </span>
            {line}
          </span>
        ))}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy commands"}
        className="absolute right-2 bottom-2 grid size-[26px] place-items-center rounded-[7px] bg-white/10 text-[12px] text-code-ink transition-colors hover:bg-white/20"
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

/** A muted text link that copies `value`. */
export function CopyText({ value, children }: { value: string; children: ReactNode }) {
  const [copied, copy] = useCopy(value);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-muted transition-colors hover:text-ink"
      onClick={copy}
    >
      {copied ? <Check /> : <CopyIcon />}
      {copied ? "Copied" : children}
    </button>
  );
}
