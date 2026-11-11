/*
 * What every guided step shares, so nothing moves between them: the progress bars, the title and
 * the line under it, a 480-wide card, and the actions centred beneath.
 */
import { ArrowRight01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { ExternalLink } from "../ui/external-link.tsx";
import { Icon } from "../ui/icon.tsx";
import { Slice } from "../ui/marks.tsx";

/** The guided steps' column in the canvas pane. `below` is drawn behind it: the iPhone. */
export function StepLayout({
  progress,
  title,
  body,
  children,
  actions,
  below,
}: {
  progress: 1 | 2 | 3;
  title: string;
  body: string;
  /** The card block, 480 wide. */
  children: ReactNode;
  /** The centred action row; empty where a card's rows carry the actions. */
  actions?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <>
      {below}
      {/*
       * 120 from the top in a window the boards' height or taller, closing to 48 in the smallest.
       * Past that the card block gives way (a card that can scroll does), never the actions.
       */}
      <div className="absolute inset-0 [container-type:size]">
        <div className="flex h-full flex-col items-center pt-[clamp(48px,calc(100cqh-730px),120px)] pb-8">
          <div
            role="progressbar"
            aria-label="Setup"
            aria-valuemin={1}
            aria-valuemax={3}
            aria-valuenow={progress}
            className="flex gap-1.5"
          >
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={cn(
                  "h-1 w-7 rounded-pill transition-colors duration-(--dur-pane)",
                  n <= progress ? "bg-ink" : "bg-step",
                )}
              />
            ))}
          </div>
          <h1 className="m-0 mt-14 font-display font-semibold text-28 text-ink tracking-[-0.02em]">
            {title}
          </h1>
          <p className="m-0 mt-3 max-w-[460px] text-center text-15 text-muted leading-[1.55]">
            {body}
          </p>
          <div className="mt-8 flex min-h-0 w-[480px] flex-col">{children}</div>
          <div className="mt-7 flex w-[480px] shrink-0 items-center justify-center gap-4">
            {actions}
          </div>
        </div>
      </div>
    </>
  );
}

/** The setup's card: white, a hairline round it. */
export function SetupCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex flex-col rounded-14 bg-surface shadow-card", className)} {...props} />
  );
}

/** A row of a setup card: a 32px mark, a title over a line, and what to do on the right. */
export function SetupRow({
  mark,
  title,
  line,
  children,
}: {
  mark: ReactNode;
  title: string;
  line?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-rule px-4 py-3 not-last:border-b">
      {mark}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-14 text-ink">{title}</span>
        {line ? <span className="text-12 text-faint">{line}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A 32px tile on the secondary ground, for a mark that isn't a picture: Claude, a key. */
export function MarkTile({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-8 bg-secondary text-muted">
      {children}
    </span>
  );
}

/** A step's one dark button, with the arrow that says it moves on. */
export function StepButton({
  children,
  busy = false,
  disabled,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant"> & { busy?: boolean }) {
  return (
    <Button
      variant="primary"
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={cn("h-9 px-[18px] text-13", busy && "disabled:opacity-100", className)}
      {...props}
    >
      {children}
      {busy ? <Waiting size={14} /> : <Icon icon={ArrowRight01Icon} step="inline" onFill />}
    </Button>
  );
}

/**
 * A row's own button: dark for the way most people go ("Sign in"), raised otherwise. `leaves`
 * marks one that opens a page outside the app.
 */
export function RowButton({
  tone,
  leaves = false,
  busy = false,
  disabled,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant"> & {
  tone: "primary" | "raised";
  leaves?: boolean;
  busy?: boolean;
}) {
  return (
    <Button
      variant={tone}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      className={cn("h-[30px] px-3 text-12", busy && "disabled:opacity-100", className)}
      {...props}
    >
      {children}
      {busy ? (
        <Waiting size={12} />
      ) : leaves ? (
        <Icon
          icon={ArrowUpRight01Icon}
          step="small"
          onFill={tone !== "raised"}
          className={tone === "raised" ? "text-muted" : undefined}
        />
      ) : null}
    </Button>
  );
}

/** The grey slice turning at half speed: waiting on a browser, GitHub or Claude. */
export function Waiting({ size, label }: { size: number; label?: string }) {
  return <Slice size={size} label={label} className="dryturn text-dry" />;
}

/** A quiet link that leaves the app, in a step's words: the app's one external link, medium. */
export function LeaveLink({ className, ...props }: ComponentProps<typeof ExternalLink>) {
  return <ExternalLink className={cn("font-medium text-12", className)} {...props} />;
}
