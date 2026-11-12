/*
 * The number a held modifier shows on what it jumps to (⌘1 on a sidebar row, ⌃2 on a page tab):
 * the 1.x studio's ShortcutHint (@ponzu/canvas), drawn with our tokens. It waits for the modifier
 * to be held a moment (useJumpShortcuts), arrives target after target and leaves all at once,
 * quicker, since the key is already up. It is always mounted, so it eases out as well as in, and
 * it only ever overlays: nothing moves to make room for it. Reduced motion shows it at once.
 */
import type { CSSProperties, ReactNode } from "react";
import { cn } from "./cn.ts";
import { JUMP_KEY, type Jump } from "./shortcut.ts";

/** Each target's hint arrives this long after the one before it. */
const STAGGER_MS = 18;

/** Waits its turn on the way in; with reduced motion every hint comes at once. */
const STAGGERED = "[transition-delay:var(--hint-delay,0ms)] motion-reduce:[transition-delay:0ms]";

/** Hint `n`'s wait (9 comes after the eighth), on the way in only. */
function stagger(n: number, shown: boolean): CSSProperties | undefined {
  if (!shown) return undefined;
  return { "--hint-delay": `${(n === 9 ? 8 : n - 1) * STAGGER_MS}ms` } as CSSProperties;
}

/**
 * The keys themselves: a small cap with the modifier and the number. `tint` sits on the chrome
 * in its text's color; `raised` sits on a picture, on a raised ground of its own. Absolutely
 * positioned: place it with `className`.
 */
export function HintKeys({
  jump,
  n,
  shown,
  tone = "tint",
  className,
}: {
  jump: Jump;
  n: number;
  shown: boolean;
  tone?: "tint" | "raised";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-hint={`${jump}-${n}`}
      data-shown={shown || undefined}
      className={cn(
        "pointer-events-none absolute flex h-4 items-center gap-px rounded-4 px-[3px] font-medium font-sans text-10 text-muted tabular-nums leading-none",
        "before:content-[attr(data-mod)] after:content-[attr(data-n)]",
        tone === "tint" ? "bg-press" : "bg-raised shadow-raised",
        // Out: all at once, quickly. In: one after another, on the pop's easing. Hidden at rest
        // (once it has faded), so nothing paints there.
        "invisible translate-y-[2px] scale-[0.96] opacity-0 transition-[opacity,translate,scale,visibility] duration-[90ms] ease-in",
        "data-shown:visible data-shown:translate-y-0 data-shown:scale-100 data-shown:opacity-100 data-shown:duration-(--dur-pop) data-shown:ease-out",
        STAGGERED,
        className,
      )}
      style={stagger(n, shown)}
      // Drawn from attributes, not text: a tab's or row's text stays its name alone, to read,
      // copy or find.
      data-mod={JUMP_KEY[jump].glyph}
      data-n={n}
    />
  );
}

/**
 * A label with no icon to give way (a page tab without one): it fades and the keys take its
 * place, centred on it, as 1.x's Home button gave its whole mark to ⌘0. Sliding the name aside
 * to make room cut it short ("Pag" for Page 1, the same for Page 2), so the tab's place in the
 * row names it instead. Its box never changes, so neither does anything around it.
 */
export function HintedLabel({
  jump,
  n,
  shown,
  className,
  children,
}: {
  jump: Jump;
  n: number | undefined;
  shown: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (n === undefined) return <span className={className}>{children}</span>;
  return (
    <span className="relative">
      <span
        className={cn(
          "block transition-opacity duration-(--dur-hover) ease-out",
          STAGGERED,
          shown && "opacity-0",
          className,
        )}
        style={stagger(n, shown)}
      >
        {children}
      </span>
      <HintKeys
        jump={jump}
        n={n}
        shown={shown}
        className="top-1/2 left-1/2 -mt-2 -translate-x-1/2"
      />
    </span>
  );
}

/**
 * An icon that gives way to the number that jumps to it while `shown`, as 1.x's tabs did: the
 * icon shrinks and fades, the keys rise over its end. The keys can be wider than the icon; they
 * hang past its end into the gap, never pushing the label.
 */
export function ShortcutHint({
  jump,
  n,
  shown,
  children,
}: {
  jump: Jump;
  /** Undefined: no shortcut reaches this one (past the eighth, not the last). */
  n: number | undefined;
  shown: boolean;
  children: ReactNode;
}) {
  if (n === undefined) return children;
  return (
    <span className="relative inline-grid shrink-0 place-items-center">
      <span
        className={cn(
          "grid transition-[opacity,scale] duration-(--dur-hover) ease-out",
          STAGGERED,
          shown && "scale-[0.7] opacity-0",
        )}
        style={stagger(n, shown)}
      >
        {children}
      </span>
      <HintKeys jump={jump} n={n} shown={shown} className="top-1/2 -right-[3px] -mt-2" />
    </span>
  );
}
