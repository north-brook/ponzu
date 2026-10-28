import { SLICE, SLICE_STROKE } from "@ponzu/react/slice";
import type { CSSProperties, SVGProps } from "react";

/**
 * The Ponzu slice. `SLICE` is the same geometry the app draws; the fill follows `--slice`, ink on
 * light and paper on dark, unless a class or style sets it.
 */
export function Slice({ size, className, ...props }: SVGProps<SVGSVGElement> & { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={`slice ${className ?? ""}`}
      {...props}
    >
      <g strokeWidth={SLICE_STROKE} strokeLinejoin="round">
        {SLICE.map((d, i) => (
          <path key={d} d={d} className="slice-seg" style={{ "--i": i } as CSSProperties} />
        ))}
      </g>
    </svg>
  );
}

/**
 * The lockup: the slice beside the lowercase word, in Funnel Display Bold. Hover turns the slice by
 * one segment (`.lockup` in globals.css).
 */
export function Lockup({ size = 22, href = "/" }: { size?: number; href?: string }) {
  return (
    <a
      className="lockup flex w-fit items-center font-display font-bold tracking-[-0.05em] text-ink"
      style={{ gap: size * 0.32, fontSize: size }}
      href={href}
    >
      <Slice size={size * 1.18} />
      <span className="-translate-y-[0.04em] leading-none">ponzu</span>
    </a>
  );
}

export function GitHub(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[1.05em] shrink-0 fill-current"
      {...props}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function Apple(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[1em] shrink-0 fill-current"
      {...props}
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

export function Check(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[1em] shrink-0 fill-none stroke-current"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** Hugeicons' Favourite, stroked like the rest of the site's line icons. Read as "love". */
export function Heart({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label="love"
      className={`size-[1.1em] shrink-0 stroke-current ${className ?? "fill-none"}`}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M10.4107 19.9677C7.58942 17.858 2 13.0348 2 8.69444C2 5.82563 4.10526 3.5 7 3.5C8.5 3.5 10 4 12 6C14 4 15.5 3.5 17 3.5C19.8947 3.5 22 5.82563 22 8.69444C22 13.0348 16.4106 17.858 13.5893 19.9677C12.6399 20.6776 11.3601 20.6776 10.4107 19.9677Z" />
    </svg>
  );
}

export function Windows(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[0.92em] shrink-0 fill-current"
      {...props}
    >
      <path d="M2 4.2 10.2 3v8.3H2zM11.3 2.9 22 1.3v10H11.3zM2 12.4h8.2v8.4L2 19.6zM11.3 12.4H22v10.3l-10.7-1.6z" />
    </svg>
  );
}

/** Tux, drawn as a silhouette with its belly and eyes cut out, so it takes `currentColor` alone. */
export function Linux(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-[1em] shrink-0 fill-current"
      fillRule="evenodd"
      {...props}
    >
      <path d="M12 1.5c-2.6 0-4.3 2.1-4.3 5 0 1.4.3 2.3-.4 3.6-1 1.8-3 4.3-3 7.6 0 .8.2 1.5.5 2.1-.9.3-1.6.9-1.3 1.6.4.9 2.4.5 4.3 1 1.3.4 2.2.3 2.8-.4.5.2 1 .3 1.4.3s.9-.1 1.4-.3c.6.7 1.5.8 2.8.4 1.9-.5 3.9-.1 4.3-1 .3-.7-.4-1.3-1.3-1.6.3-.6.5-1.3.5-2.1 0-3.3-2-5.8-3-7.6-.7-1.3-.4-2.2-.4-3.6 0-2.9-1.7-5-4.3-5zM12 10.8c-2 0-3.6 2.2-3.6 4.8s1.6 4.8 3.6 4.8 3.6-2.2 3.6-4.8-1.6-4.8-3.6-4.8zM10.4 5.15a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1zM13.6 5.15a1.05 1.05 0 1 0 0 2.1 1.05 1.05 0 0 0 0-2.1z" />
    </svg>
  );
}

/** A tray arrow: a download whose platform we can't name. */
export function DownloadArrow(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-[1em] shrink-0 fill-none stroke-current"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 2v8.5m-3.5-3.5L8 10.5 11.5 7M3 13.5h10" />
    </svg>
  );
}

export function Chevron(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="size-3 shrink-0 fill-none stroke-current"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  );
}

export function PhoneIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 14 16"
      aria-hidden="true"
      className="h-[1em] w-[0.8em] shrink-0 fill-none stroke-current"
      strokeWidth={1.5}
      {...props}
    >
      <rect x="2.5" y="0.8" width="9" height="14.4" rx="2.2" />
      <path d="M5.8 2.9h2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Terminal(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 14"
      aria-hidden="true"
      className="size-[1em] shrink-0 fill-none stroke-current"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2 3l4 4-4 4M8.5 11.5H14" />
    </svg>
  );
}

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-[1em] shrink-0 fill-none stroke-current"
      strokeWidth={1.5}
      {...props}
    >
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="2" />
      <path
        d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H4"
        strokeLinecap="round"
      />
    </svg>
  );
}
