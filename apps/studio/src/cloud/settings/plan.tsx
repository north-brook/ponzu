import { ArrowUpRight01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { type ReactNode, useState } from "react";
import { Avatar } from "../ui/avatar.tsx";
import { cn } from "../ui/cn.ts";
import { TextField } from "../ui/field.tsx";
import { useFocusReturn } from "../ui/focus-return.ts";
import {
  atCap,
  type CardBrand as Brand,
  billedUsd,
  money,
  type PersonUsage,
  parseCap,
  type Usage,
  usageBar,
  usageLine,
} from "./billing.ts";
import { CardBrand } from "./card-brand.tsx";
import { QuietButton, RowIcon, SectionLabel } from "./parts.tsx";

export interface TeamUsage {
  name: string;
  people: number;
  /** Everyone's use, for an admin; null for anyone else, who sees only their own. */
  byPerson: PersonUsage[] | null;
  mine: PersonUsage;
}

/** What one design used this period; `name` null for those the viewer can't see by name. */
export interface DesignUsage {
  id: string | null;
  name: string | null;
  usedCredits: number;
}

export interface PlanSectionProps {
  usage: Usage;
  /** A team's workspace; null for a personal one. */
  team: TeamUsage | null;
  /** May change the cap and the card: a team's admin, or anyone in their own workspace. */
  canManage: boolean;
  onCapChange: (usd: number) => void;
  /** Stripe's portal, where the card is replaced and invoices are; only with a card. */
  onManageCard?: () => void;
  /** Left out while cards can't be added yet: the row says there is none, and offers nothing. */
  onAddCard?: () => void;
  /** Use by design, most first, for whoever may see it (an admin); left out, not shown. */
  byDesign?: DesignUsage[] | null;
}

const BRAND_NAMES: Record<Brand, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  other: "Card",
};

/**
 * Plan and usage: what the month has cost so far, how that sits against the free credits and the
 * cap, and the card that pays. A team shares one card, one cap and its free credits; its admins
 * see who used what.
 */
export function PlanSection({
  usage,
  team,
  canManage,
  onCapChange,
  onManageCard,
  onAddCard,
  byDesign,
}: PlanSectionProps) {
  const billed = billedUsd(usage);
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="font-display font-semibold text-40 text-ink leading-none tracking-[-0.02em]">
          {money(billed)}
        </span>
        <span className="text-13 text-muted">
          {usageLine(usage, team ? { name: team.name, people: team.people } : undefined)}
        </span>
      </div>
      <UsageBar usage={usage} />
      <div className="flex flex-col border-rule border-t">
        {usage.capUsd !== null ? (
          <CapRow
            capUsd={usage.capUsd}
            billed={billed}
            team={team !== null}
            canManage={canManage}
            onChange={onCapChange}
          />
        ) : null}
        {canManage ? (
          <PlanRow
            label="Card"
            action={
              usage.card && onManageCard ? (
                <RowIcon
                  icon={ArrowUpRight01Icon}
                  label="Manage in Stripe"
                  onClick={onManageCard}
                />
              ) : null
            }
          >
            {usage.card ? (
              <>
                <CardBrand brand={usage.card.brand} />
                <span className="truncate">
                  {BRAND_NAMES[usage.card.brand]} ending {usage.card.last4}
                  {team ? ` · ${team.name}` : ""}
                </span>
                {usage.card.failed ? <span className="text-danger">Payment failed</span> : null}
              </>
            ) : (
              <>
                <span className="flex-1 font-normal text-muted">No card yet</span>
                {onAddCard ? <QuietButton onClick={onAddCard}>Add a card</QuietButton> : null}
              </>
            )}
          </PlanRow>
        ) : null}
      </div>
      {team ? (
        team.byPerson ? (
          <People label="By person · only admins see this" people={team.byPerson} usage={usage} />
        ) : (
          <People label="Your usage" people={[team.mine]} usage={usage} />
        )
      ) : null}
      {byDesign?.length ? <Designs designs={byDesign} usage={usage} /> : null}
    </>
  );
}

/** Use by design, in gross dollars, as the API orders it: most first, the unnamed last. */
function Designs({ designs, usage }: { designs: DesignUsage[]; usage: Usage }) {
  return (
    <section aria-label="By design" className="flex flex-col">
      <SectionLabel className="pb-1">By design</SectionLabel>
      {designs.map(({ id, name, usedCredits }) => (
        <div
          key={id ?? "others"}
          className="flex h-[38px] items-center gap-2.5 border-rule border-t"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-13",
              name ? "font-medium text-ink" : "text-muted",
            )}
          >
            {name ?? "Designs you can't open"}
          </span>
          <span className="w-20 text-right font-medium font-mono text-12 text-muted leading-none">
            {money(usedCredits * usage.creditUsd)}
          </span>
        </div>
      ))}
    </section>
  );
}

/**
 * Free credits hatched from the left, what is billed in ink after them with a sliver of the
 * surface where billing starts, against the free credits plus what the cap buys.
 */
function UsageBar({ usage }: { usage: Usage }) {
  const { free, billed } = usageBar(usage);
  const capped = atCap(usage);
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return (
    <div className="flex flex-col gap-2.5">
      {/* biome-ignore lint/a11y/useSemanticElements: <meter> can't be drawn as the design's bar */}
      <div
        role="meter"
        aria-label="Usage this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((free + billed) * 100)}
        className="relative h-2 overflow-hidden rounded-pill bg-track"
      >
        <span className="hatch absolute inset-y-0 left-0" style={{ width: pct(free) }} />
        {billed > 0 ? (
          <>
            <span
              className="absolute inset-y-0 bg-ink"
              style={{ left: pct(free), width: pct(billed) }}
            />
            <span className="absolute inset-y-0 w-0.5 bg-surface" style={{ left: pct(free) }} />
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-3.5 text-12 text-muted">
        <span className="flex items-center gap-1.5">
          <span className="hatch h-2 w-2.5 rounded-2" />
          {money(usage.freeCredits * usage.creditUsd, true)} free
        </span>
        {usage.capUsd !== null ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-pill bg-ink" />
              {money(billedUsd(usage), true)} billed
            </span>
            <span className="flex-1" />
            <span className={cn(capped && "font-medium text-ink")}>
              Cap {money(usage.capUsd, true)}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A 46-tall row: what it is in a 110 column, its value, one action at the end. */
function PlanRow({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-[46px] items-center gap-2.5 border-rule not-last:border-b">
      <span className="w-[110px] shrink-0 text-13 text-muted">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2.5 font-medium text-13 text-ink">
        {children}
      </span>
      {action}
    </div>
  );
}

/**
 * The monthly cap, which the pencil turns into a field in place: Return or leaving it saves,
 * Escape puts it back. It can't go below what this month has billed; a cap below that stays in
 * the field with the reason until it is changed or Escape puts it back.
 */
function CapRow({
  capUsd,
  billed,
  team,
  canManage,
  onChange,
}: {
  capUsd: number;
  billed: number;
  team: boolean;
  canManage: boolean;
  onChange: (usd: number) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const focus = useFocusReturn();
  const parsed = typed === null ? null : parseCap(typed, billed);
  const commit = () => {
    if (parsed?.ok && parsed.usd !== capUsd) onChange(parsed.usd);
    setTyped(null);
  };
  return (
    <PlanRow
      label="Monthly cap"
      action={
        canManage && typed === null ? (
          <RowIcon
            ref={focus.target("cap")}
            icon={PencilEdit02Icon}
            label="Change cap"
            onClick={() => setTyped(String(capUsd))}
          />
        ) : null
      }
    >
      {typed === null ? (
        `${money(capUsd, true)}${team ? " for the team" : ""}`
      ) : (
        <>
          <TextField
            compact
            autoFocus
            data-keeps-escape
            aria-label="Monthly cap in dollars"
            inputMode="numeric"
            invalid={parsed?.ok === false}
            leading={<span className="font-normal text-12 text-faint">$</span>}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onFocus={(e) => e.target.select()}
            // A cap it can't be stays in the field with its reason, rather than vanishing.
            onBlur={() => parsed?.ok && commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && parsed?.ok) {
                // Held back, or the Return would go on to press the pencil it focuses.
                e.preventDefault();
                focus.returnTo("cap");
                commit();
              }
              if (e.key === "Escape") {
                focus.returnTo("cap");
                setTyped(null);
              }
            }}
            className="w-[120px]"
          />
          {parsed?.ok === false ? (
            <span role="alert" className="font-normal text-12 text-danger">
              {parsed.error}
            </span>
          ) : null}
        </>
      )}
    </PlanRow>
  );
}

/** Use by person, in gross dollars before the pooled free credits, most first. */
function People({ label, people, usage }: { label: string; people: PersonUsage[]; usage: Usage }) {
  const sorted = [...people].sort((a, b) => b.usedCredits - a.usedCredits);
  return (
    <section aria-label={label} className="flex flex-col">
      <SectionLabel className="pb-1">{label}</SectionLabel>
      {sorted.map(({ person, admin, usedCredits }) => (
        <div key={person.id} className="flex h-[38px] items-center gap-2.5 border-rule border-t">
          <Avatar person={person} size={22} />
          <span className="min-w-0 flex-1 truncate font-medium text-13 text-ink">
            {person.name}
            {admin ? <span className="ml-1.5 font-normal text-11 text-faint">admin</span> : null}
          </span>
          <span className="w-20 text-right font-medium font-mono text-12 text-muted leading-none">
            {money(usedCredits * usage.creditUsd)}
          </span>
        </div>
      ))}
    </section>
  );
}
