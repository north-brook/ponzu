import { type CatalogMachine, type UpdatePlan, updatePlan } from "@ponzu/core";
import { Icon } from "@ponzu/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * A quiet button in the title bar, with a yuzu dot, once any of the person's Macs has a newer
 * Ponzu downloaded. Its popover has the release notes, which are what's new: nothing shows them
 * again after the restart. Restart installs it on every Mac behind: the server asks each of the
 * others, then restarts this one into it (`POST /api/update`). A Mac whose agent is mid-change
 * waits for it, and one that's off catches up once it's back. Hovering the Mac count, shown only
 * when there's more than this one, lists each Mac and when it updates.
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
      // No Mac said it would: offer Restart again rather than spin.
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
            updating ? `Updating to Ponzu ${plan.version}` : `Ponzu ${plan.version} is ready`
          }
          className="app-no-drag relative grid size-7 shrink-0 place-items-center rounded-lg bg-secondary text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Icon
            name={updating ? "loading" : "upload"}
            size={15}
            strokeWidth={1.9}
            className={cn(updating && "animate-spin")}
          />
          {!updating && (
            <span className="absolute top-[3px] right-[3px] size-[7px] rounded-full bg-flesh shadow-[0_0_0_2px_var(--background)]" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px]">
        <UpdateBody
          plan={plan}
          machines={machines ?? []}
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
  machines = [],
  updating,
  onUpdate,
  onLater,
}: {
  plan: UpdatePlan;
  machines?: CatalogMachine[];
  updating: boolean;
  onUpdate?: () => void;
  onLater?: () => void;
}) {
  // This Mac's own restart waits for its agent.
  const waiting = machines.find((m) => m.id === "local")?.update?.waitsFor;
  if (updating)
    return (
      <div className="flex flex-col gap-0.5">
        <span className="font-semibold text-[14px] leading-5">Updating to {plan.version}</span>
        <span className="text-[12px] text-muted-foreground leading-[17px]">
          {waiting
            ? `Ponzu restarts once ${agentName(waiting)} finishes, and reopens your tabs.`
            : "Ponzu restarts in a moment and reopens your tabs. Agents reconnect on their own."}
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
        {plan.macs.length > 1 && <MacCount plan={plan} machines={machines} />}
        <span className="flex-1" />
        <Button variant="outline" size="sm" onClick={onLater}>
          Later
        </Button>
        <Button size="sm" onClick={onUpdate} className="gap-1.5 pl-2">
          <Icon name="refresh" size={14} strokeWidth={1.9} />
          Restart
        </Button>
      </div>
    </div>
  );
}

/** How many Macs Restart updates. Hovering it lists each, and when it updates. */
function MacCount({ plan, machines }: { plan: UpdatePlan; machines: CatalogMachine[] }) {
  const behind = plan.macs.flatMap((id) => machines.find((m) => m.id === id) ?? []);
  const count =
    plan.macs.length === plan.of
      ? `On all ${plan.of} of your Macs`
      : `On ${plan.macs.length} of your Macs`;
  // The list is in the name too: the card opens on focus, but a screen reader can't reach it.
  const each = behind
    .map((m) => [m.name, m.update?.version, when(m)].filter(Boolean).join(", "))
    .join("; ");
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={each ? `${count}: ${each}` : count}
          className="-ml-1.5 inline-flex h-6 cursor-default items-center gap-[5px] whitespace-nowrap rounded-md px-1.5 text-[12px] text-muted-foreground tabular-nums outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Icon name="laptop" size={13} />
          {plan.macs.length}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" side="bottom" className="w-[248px] p-1.5">
        <ul className="m-0 flex list-none flex-col p-0 text-[12.5px]">
          {behind.map((m) => (
            <li key={m.id} className="flex items-baseline gap-2 px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                <span className="text-faint"> · {when(m)}</span>
              </span>
              <span className="text-faint tabular-nums">{m.update?.version}</span>
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}

/** When Restart reaches this Mac. */
function when(m: CatalogMachine): string {
  if (m.update?.waitsFor) return `after ${agentName(m.update.waitsFor)} finishes`;
  if (m.id === "local") return "restarts last";
  return "now";
}

function agentName(client?: string): string {
  if (client === "claude") return "Claude";
  if (client === "openai") return "Codex";
  if (client === "cursor") return "Cursor";
  return "your agent";
}
