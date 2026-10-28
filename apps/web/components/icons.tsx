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

/**
 * A Hugeicons line icon (the set the brand, the app and the phone draw with), on its 24-unit grid at
 * its 1.5 stroke. `className` adds to the stroke styling rather than replacing it, so a size or a
 * turn can't leave the path filled.
 */
function Huge({
  paths,
  className = "size-[1em]",
  ...props
}: SVGProps<SVGSVGElement> & { paths: string[] }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`shrink-0 fill-none stroke-current ${className}`}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

type Icon = Omit<SVGProps<SVGSVGElement>, "children">;

/** Hugeicons' ArrowDown01: the split button's menu. */
export function Chevron(props: Icon) {
  return <Huge paths={["M18 9.00005C18 9.00005 13.5811 15 12 15C10.4188 15 6 9 6 9"]} {...props} />;
}

/** Hugeicons' Download01: a download whose platform we can't name. */
export function DownloadArrow(props: Icon) {
  return (
    <Huge
      paths={[
        "M2.99969 17.0002C2.99969 17.9302 2.99969 18.3952 3.10192 18.7767C3.37932 19.8119 4.18796 20.6206 5.22324 20.898C5.60474 21.0002 6.06972 21.0002 6.99969 21.0002L16.9997 21.0002C17.9297 21.0002 18.3947 21.0002 18.7762 20.898C19.8114 20.6206 20.6201 19.8119 20.8975 18.7767C20.9997 18.3952 20.9997 17.9302 20.9997 17.0002",
        "M16.4998 11.5002C16.4998 11.5002 13.1856 16.0002 11.9997 16.0002C10.8139 16.0002 7.49976 11.5002 7.49976 11.5002M11.9997 15.0002V3.00016",
      ]}
      {...props}
    />
  );
}

/** Hugeicons' SmartPhone01: the iPhone app. */
export function PhoneIcon(props: Icon) {
  return (
    <Huge
      paths={[
        "M13.5 2H10.5C8.14298 2 6.96447 2 6.23223 2.73223C5.5 3.46447 5.5 4.64298 5.5 7V17C5.5 19.357 5.5 20.5355 6.23223 21.2678C6.96447 22 8.14298 22 10.5 22H13.5C15.857 22 17.0355 22 17.7678 21.2678C18.5 20.5355 18.5 19.357 18.5 17V7C18.5 4.64298 18.5 3.46447 17.7678 2.73223C17.0355 2 15.857 2 13.5 2Z",
        "M12.125 19H12M12.25 19C12.25 19.1381 12.1381 19.25 12 19.25C11.8619 19.25 11.75 19.1381 11.75 19C11.75 18.8619 11.8619 18.75 12 18.75C12.1381 18.75 12.25 18.8619 12.25 19Z",
      ]}
      {...props}
    />
  );
}

/** Hugeicons' CommandLine: the CLI. */
export function Terminal(props: Icon) {
  return (
    <Huge
      paths={[
        "M14 4H10C6.22876 4 4.34315 4 3.17157 5.17157C2 6.34315 2 8.22876 2 12C2 15.7712 2 17.6569 3.17157 18.8284C4.34315 20 6.22876 20 10 20H14C17.7712 20 19.6569 20 20.8284 18.8284C22 17.6569 22 15.7712 22 12C22 8.22876 22 6.34315 20.8284 5.17157C19.6569 4 17.7712 4 14 4Z",
        "M7 9L8.83981 10.5858C9.61327 11.2525 10 11.5858 10 12C10 12.4142 9.61327 12.7475 8.83981 13.4142L7 15",
        "M13 16H17",
      ]}
      {...props}
    />
  );
}

/** Hugeicons' Copy01. */
export function CopyIcon(props: Icon) {
  return (
    <Huge
      paths={[
        "M7.5 14.5C7.5 11.2002 7.5 9.55025 8.52513 8.52513C9.55025 7.5 11.2002 7.5 14.5 7.5C17.7998 7.5 19.4497 7.5 20.4749 8.52513C21.5 9.55025 21.5 11.2002 21.5 14.5C21.5 17.7998 21.5 19.4497 20.4749 20.4749C19.4497 21.5 17.7998 21.5 14.5 21.5C11.2002 21.5 9.55025 21.5 8.52513 20.4749C7.5 19.4497 7.5 17.7998 7.5 14.5Z",
        "M7.5 16.5C6.10355 16.5 5.40533 16.5 4.84402 16.3036C3.83866 15.9518 3.0482 15.1613 2.69641 14.156C2.5 13.5947 2.5 12.8964 2.5 11.5V9.5C2.5 6.20017 2.5 4.55025 3.52513 3.52513C4.55025 2.5 6.20017 2.5 9.5 2.5H11.5C12.8964 2.5 13.5947 2.5 14.156 2.69641C15.1613 3.0482 15.9518 3.83866 16.3036 4.84402C16.5 5.40533 16.5 6.10355 16.5 7.5",
      ]}
      {...props}
    />
  );
}

/** Hugeicons' Share03: the system share sheet. */
export function ShareIcon(props: Icon) {
  return (
    <Huge
      paths={[
        "M8 7C8 7 10.1958 4.28386 11.4044 3.23889C11.5987 3.0709 11.8169 2.99152 12.0337 3.00072C12.2282 3.00897 12.4215 3.08844 12.5958 3.23912C13.8041 4.28428 16 7 16 7M12.0337 4L12.0337 15",
        "M8 11C6.59987 11 5.8998 11 5.36502 11.2725C4.89462 11.5122 4.51217 11.8946 4.27248 12.365C4 12.8998 4 13.5999 4 15V16C4 18.357 4 19.5355 4.73223 20.2678C5.46447 21 6.64298 21 9 21H15C17.357 21 18.5355 21 19.2678 20.2678C20 19.5355 20 18.357 20 16V15C20 13.5999 20 12.8998 19.7275 12.365C19.4878 11.8946 19.1054 11.5122 18.635 11.2725C18.1002 11 17.4001 11 16 11",
      ]}
      {...props}
    />
  );
}
