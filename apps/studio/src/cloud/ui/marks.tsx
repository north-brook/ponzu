/*
 * Brand marks, drawn as the design draws them rather than taken from an icon set. Claude's is the
 * canvas's AgentMark.
 */
import { SLICE, SLICE_STROKE } from "@ponzu/canvas/slice";
import { LOCKUP, WORDMARK } from "@ponzu/core/wordmark";
import { cn } from "./cn.ts";

export { AgentMark } from "@ponzu/canvas/icons";

/**
 * The Ponzu slice in `currentColor`. `turning` is the agent at work: a sixth of a turn a beat.
 * Without a label it is decoration.
 */
export function Slice({
  size,
  turning = false,
  label,
  className,
}: {
  size: number;
  turning?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0", turning && "juiceturn", className)}
    >
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={SLICE_STROKE}
        strokeLinejoin="round"
      >
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Ponzu's lockup in `currentColor`: the slice beside the lowercase word, as the site draws it.
 * `size` is the word's font size; the drawing is 1.18 of it tall. The word is a path, since the
 * app ships its display face at 600 and the lockup's is bold.
 */
export function Lockup({
  size,
  label,
  className,
}: {
  size: number;
  label?: string;
  className?: string;
}) {
  const { slice, word } = LOCKUP;
  return (
    <svg
      width={(LOCKUP.width * size) / 100}
      height={(LOCKUP.height * size) / 100}
      viewBox={LOCKUP.viewBox}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0", className)}
    >
      <g
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={SLICE_STROKE}
        strokeLinejoin="round"
        transform={`translate(${slice.x} ${slice.y}) scale(${slice.scale})`}
      >
        {SLICE.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <path fill="currentColor" transform={`translate(${word.x} 0)`} d={WORDMARK} />
    </svg>
  );
}

const GITHUB =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

/** GitHub's mark in `currentColor`. */
export function GithubMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path d={GITHUB} />
    </svg>
  );
}

const APPLE =
  "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";

/** Apple's logo in `currentColor`: where the App Store is meant. */
export function AppleMark({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path d={APPLE} />
    </svg>
  );
}
