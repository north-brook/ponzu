import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { Effort, ModelOption } from "../model.ts";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import {
  Menu,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
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
  models: ModelOption[];
  efforts: Effort[];
  model: string;
  effort: Effort;
  onChange: (model: string, effort: Effort) => void;
}

/** The model and effort a new design runs with: Claude's mark, the model, the effort, quietly. */
export function ModelPicker({ models, efforts, model, effort, onChange }: ModelChoice) {
  const label = models.find((m) => m.id === model)?.label ?? model;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="quiet"
          aria-label={`Model: ${label}, effort ${EFFORT_LABELS[effort]}`}
          className="mr-1 gap-[5px] pr-1.5 pl-2"
        >
          <AgentMark client="claude" size={13} />
          {label}
          <span className="font-normal text-faint">· {EFFORT_LABELS[effort]}</span>
          <Icon icon={ArrowDown01Icon} step="meta" />
        </Button>
      </MenuTrigger>
      <MenuContent width={220} side="bottom" align="end" sideOffset={6}>
        <MenuLabel>Model</MenuLabel>
        <MenuRadioGroup value={model} onValueChange={(id) => onChange(id, effort)}>
          {models.map((m) => (
            <MenuRadioItem key={m.id} value={m.id}>
              {m.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuLabel>Effort</MenuLabel>
        <MenuRadioGroup value={effort} onValueChange={(e) => onChange(model, e as Effort)}>
          {efforts.map((e) => (
            <MenuRadioItem key={e} value={e}>
              {EFFORT_LABELS[e]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
