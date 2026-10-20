import type { SVGProps } from "react";

export function Wedge({ size, ...props }: SVGProps<SVGSVGElement> & { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" {...props}>
      <path fill="var(--rind)" d="M12.96 3.00A33.96 33.96 0 0 0 61.00 51.04Z" />
      <path fill="var(--pith)" d="M17.08 7.12A28.14 28.14 0 0 0 56.88 46.92Z" />
      <path fill="var(--flesh)" d="M19.57 9.61A24.62 24.62 0 0 0 54.39 44.43Z" />
      <path fill="var(--pith)" d="M17.08 7.12L56.88 46.92L54.39 49.41L14.59 9.61Z" />
      <path
        stroke="var(--pith)"
        d="M34.49 29.51L30.61 50.80M34.49 29.51L13.20 33.39"
        strokeWidth="3.4"
        strokeLinecap="round"
        fill="none"
      />
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
