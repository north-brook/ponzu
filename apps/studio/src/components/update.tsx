import { type CatalogMachine, type UpdatePlan, updatePlan } from "@ponzu/core";
import { Icon } from "@ponzu/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Update, in the title bar, once any of the person's Macs has a newer Ponzu downloaded. Its
 * popover says what's new, and one click installs it on every Mac behind: the server asks each
 * of the others, then restarts this one into it (`POST /api/update`). It names how many Macs
 * only when there's more than this one. A Mac that's off catches up once it's back.
 */
export function UpdateButton({
  machines,
  origin,
}: {
  machines: CatalogMachine[] | undefined;
  origin: string;
}) {
  const plan = updatePlan(machines ?? []);
  const [asked, setAsked] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /** Whether a Mac said it was installing what was asked for, since it was asked. */
  const started = useRef(false);
  const installing = Boolean(plan?.installing);
  useEffect(() => {
    // A new version to offer: what was asked for before was for another.
    if (plan && asked && asked !== plan.version) setAsked(null);
    else if (asked && installing) started.current = true;
    // It started and stopped without the version changing: the download failed. Offer it again.
    else if (asked && started.current && !installing) setAsked(null);
  }, [plan, asked, installing]);
  if (!plan) return null;
  const updating = plan.installing || asked === plan.version;

  const update = async () => {
    started.current = false;
    setAsked(plan.version);
    try {
      const res = await fetch(`${origin}/api/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ macs: plan.macs, version: plan.version }),
      });
      const body = res.ok ? ((await res.json()) as { macs?: Record<string, boolean> }) : null;
      // No Mac said it would: offer Update again rather than spin.
      if (!Object.values(body?.macs ?? {}).some(Boolean)) setAsked(null);
    } catch {
      // This Mac restarting can cut its own answer short; the catalog says how it went.
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            updating ? `Updating to Ponzu ${plan.version}` : `Update to Ponzu ${plan.version}`
          }
          className={cn(
            "app-no-drag inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 font-medium text-[12px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
            updating
              ? "bg-secondary text-foreground shadow-[inset_0_0_0_1px_var(--hairline-strong)]"
              : "update-pill bg-flesh text-[#111110] hover:brightness-[0.97]",
          )}
        >
          <Icon
            name={updating ? "loading" : "upload"}
            size={14}
            strokeWidth={2}
            className={cn(updating && "animate-spin")}
          />
          {updating ? "Updating" : "Update"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px]">
        <UpdateBody
          plan={plan}
          updating={updating}
          onUpdate={update}
          onLater={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The popover's contents, apart for tests. */
export function UpdateBody({
  plan,
  updating,
  onUpdate,
  onLater,
}: {
  plan: UpdatePlan;
  updating: boolean;
  onUpdate?: () => void;
  onLater?: () => void;
}) {
  if (updating)
    return (
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold text-[14px] leading-5">Updating to {plan.version}</span>
        <span className="text-[12px] text-muted-foreground leading-[17px]">
          Ponzu restarts in a moment and reopens your tabs. Agents reconnect on their own.
        </span>
      </div>
    );
  return (
    <div className="flex flex-col gap-3.5">
      <span className="font-semibold text-[14px] leading-5">Ponzu {plan.version}</span>
      {plan.notes.length > 0 && (
        <ul className="flex max-h-[min(320px,50vh)] list-disc flex-col gap-1.5 overflow-y-auto pl-[18px] leading-[19px] marker:text-muted-foreground">
          {plan.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        {plan.macs.length > 1 && (
          <span
            title={
              plan.macs.length === plan.of
                ? `On all ${plan.of} of your Macs`
                : `On ${plan.macs.length} of your Macs`
            }
            className="inline-flex items-center gap-[5px] whitespace-nowrap text-[12px] text-muted-foreground tabular-nums"
          >
            <Icon name="laptop" size={13} />
            {plan.macs.length}
          </span>
        )}
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={onLater}>
          Later
        </Button>
        <Button size="sm" onClick={onUpdate}>
          Update
        </Button>
      </div>
    </div>
  );
}
