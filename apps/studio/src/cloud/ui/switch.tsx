import { Switch as S } from "radix-ui";
import { cn } from "./cn.ts";

/** An on/off setting that saves as it is flipped: 34 by 20, the knob sliding 14px. */
export function Switch({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  /** Its name for assistive tech: the row's title. */
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <S.Root
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        "relative h-5 w-[34px] shrink-0 cursor-default rounded-pill outline-none transition-colors duration-(--dur-pop) ease-out focus-ring disabled:opacity-35",
        checked ? "bg-action" : "bg-switch-off",
      )}
    >
      <S.Thumb className="absolute top-0.5 left-0.5 block size-4 rounded-pill bg-knob shadow-knob transition-transform duration-(--dur-pop) ease-out data-[state=checked]:translate-x-[14px]" />
    </S.Root>
  );
}
