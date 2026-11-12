import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useId, useRef } from "react";
import { type Effort, effortFor, effortsOf, type ModelOption } from "../model.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import {
  Menu,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu.tsx";

export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export interface ModelChoice {
  /** What the person's Claude account offers, in order. */
  models: readonly ModelOption[];
  /** The efforts to list for a model that does not say which it takes. */
  efforts: readonly Effort[];
  model: string;
  effort: Effort;
  onChange: (model: string, effort: Effort) => void;
}

/** The panes: the models' fits its longest name between these; the efforts' is one width. */
const MODELS_MIN = 152;
const MODELS_MAX = 232;
const EFFORTS_PANE = 128;

/** Keys that move within a pane; Left and Right move between them. */
const WITHIN = new Set(["ArrowUp", "ArrowDown", "Home", "End"]);

/** A pane's rows, top to bottom. */
const rows = (pane: Element | null) => [
  ...(pane?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []),
];

/**
 * The model and effort a new design runs with: Claude's mark, the model, the effort, quietly,
 * one step under the composer's own type size (14 to its 16). A model that takes no effort shows
 * its name alone.
 *
 * Its menu is two panes side by side, opening upward from the composer docked at the pane's
 * foot: the models, and the efforts the chosen model takes (or a line saying it takes none).
 * Choosing a model keeps the menu open, since the effort beside it may be what comes next;
 * choosing an effort closes it, and so does choosing a model that takes none. Left and Right
 * move between the panes, onto the other's chosen row; Up, Down, Home and End stay within one.
 * Each pane is a radio group named by its label. `after` takes the focus once something was
 * chosen and the menu has closed (the composer, to go on typing); closed without a choice, focus
 * goes back to the trigger as any menu's does.
 */
export function ModelPicker({
  models,
  efforts,
  model,
  effort,
  onChange,
  after,
}: ModelChoice & { after?: () => void }) {
  const label = models.find((m) => m.id === model)?.label ?? model;
  const takes = effortsOf(models, efforts, model);
  const chose = useRef(false);
  const ids = useId();
  const choose = (nextModel: string, nextEffort: Effort) => {
    chose.current = true;
    onChange(nextModel, nextEffort);
  };
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) chose.current = false;
      }}
    >
      <MenuTrigger asChild>
        <Button
          variant="quiet"
          aria-label={
            takes.length ? `Model: ${label}, effort ${EFFORT_LABELS[effort]}` : `Model: ${label}`
          }
          className="mr-1 gap-1.5 pr-1.5 pl-2 text-14"
        >
          <AgentMark client="claude" size={14} />
          {label}
          {takes.length ? (
            <span className="font-normal text-faint">{EFFORT_LABELS[effort]}</span>
          ) : null}
          <Icon icon={ArrowDown01Icon} step="small" />
        </Button>
      </MenuTrigger>
      <MenuContent
        width="max-content"
        side="top"
        align="end"
        sideOffset={6}
        aria-describedby={takes.length ? undefined : `${ids}-none`}
        className="flex-row"
        // Ahead of Radix's own keys, which walk every row of the menu as one list.
        onKeyDownCapture={(e) => {
          const from = e.target as HTMLElement;
          const pane = from.closest<HTMLElement>("[data-pane]");
          if (!pane) return;
          let to: HTMLElement | undefined;
          if (WITHIN.has(e.key)) {
            const here = rows(pane);
            const step = e.key === "ArrowUp" ? -1 : 1;
            const at = Math.max(0, Math.min(here.length - 1, here.indexOf(from) + step));
            to = e.key === "Home" ? here[0] : e.key === "End" ? here.at(-1) : here[at];
          } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            const name = e.key === "ArrowRight" ? "effort" : "model";
            if (pane.dataset.pane === name) return;
            const other = rows(e.currentTarget.querySelector(`[data-pane="${name}"]`));
            to = other.find((r) => r.getAttribute("aria-checked") === "true") ?? other[0];
          } else {
            return;
          }
          // Nowhere to go (past a pane's end, or a model that takes no effort): nothing moves.
          e.preventDefault();
          e.stopPropagation();
          to?.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (!chose.current || !after) return;
          chose.current = false;
          e.preventDefault();
          after();
        }}
      >
        <div
          data-pane="model"
          className="flex min-w-0 flex-col"
          style={{ minWidth: MODELS_MIN, maxWidth: MODELS_MAX }}
        >
          <MenuLabel id={`${ids}-models`}>Model</MenuLabel>
          <MenuRadioGroup
            aria-labelledby={`${ids}-models`}
            value={model}
            onValueChange={(id) => choose(id, effortFor(models, efforts, id, effort))}
          >
            {models.map((m) => (
              <MenuRadioItem
                key={m.id}
                value={m.id}
                // A name cut short shows whole under the pointer.
                title={m.label}
                onSelect={(e) => {
                  // The menu stays open while an effort beside it may be what comes next.
                  if (effortsOf(models, efforts, m.id).length) e.preventDefault();
                }}
              >
                {m.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </div>
        <div aria-hidden className="mx-1.5 w-px shrink-0 self-stretch bg-rule" />
        <div data-pane="effort" className="flex min-w-0 flex-col" style={{ width: EFFORTS_PANE }}>
          <MenuLabel id={`${ids}-efforts`}>Effort</MenuLabel>
          {takes.length ? (
            <MenuRadioGroup
              aria-labelledby={`${ids}-efforts`}
              value={effort}
              onValueChange={(e) => choose(model, e as Effort)}
            >
              {takes.map((e) => (
                <MenuRadioItem key={e} value={e}>
                  {EFFORT_LABELS[e]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          ) : (
            // Nothing to choose, so not a row: in a row's place, quiet. Assistive tech hears it
            // as the menu's description.
            <p
              id={`${ids}-none`}
              data-no-effort
              className="m-0 flex h-8 items-center px-2 text-12 text-faint"
            >
              None for this model
            </p>
          )}
        </div>
      </MenuContent>
    </Menu>
  );
}
