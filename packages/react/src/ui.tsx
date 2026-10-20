import { cva, type VariantProps } from "class-variance-authority";
import { type ClassValue, clsx } from "clsx";
import { DropdownMenu as MenuPrimitive, ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * The canvas's shadcn components (components.json), with every class under
 * the `pz:` prefix so they can't collide with a host app's Tailwind.
 */

const twMerge = extendTailwindMerge({ prefix: "pz" });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const buttonVariants = cva(
  "pz:inline-flex pz:shrink-0 pz:items-center pz:justify-center pz:gap-1.5 pz:whitespace-nowrap pz:outline-none pz:focus-visible:ring-2 pz:focus-visible:ring-ring/50 pz:disabled:pointer-events-none pz:disabled:opacity-30",
  {
    variants: {
      variant: {
        default: "pz:bg-primary pz:text-primary-foreground pz:hover:bg-primary/90",
        ghost: "pz:text-muted-foreground pz:hover:bg-accent pz:hover:text-foreground",
      },
      size: {
        default: "pz:h-7 pz:rounded-lg pz:px-2.5",
        icon: "pz:size-[26px] pz:rounded-[7px]",
        "icon-lg": "pz:size-7 pz:rounded-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      type={type}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

/** Grows with its text. Borderless: it sits inside the card that frames it. */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "pz:field-sizing-content pz:min-h-7 pz:w-full pz:resize-none pz:bg-transparent pz:py-1 pz:outline-0 pz:placeholder:text-muted-foreground pz:disabled:cursor-not-allowed pz:disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

const toggleGroupVariants = cva("pz:flex pz:gap-0.5 pz:p-0.5", {
  variants: {
    variant: {
      /** The mode switcher: the chosen one gets a soft chip. */
      solid: "pz:rounded-[9px]",
      /** A segmented control: the chosen one lifts. */
      segmented: "pz:rounded-lg pz:bg-muted",
    },
  },
  defaultVariants: { variant: "solid" },
});

const toggleGroupItemVariants = cva(
  "pz:text-muted-foreground pz:outline-none pz:hover:text-foreground pz:focus-visible:ring-2 pz:focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        solid:
          "pz:grid pz:h-[26px] pz:w-[30px] pz:place-items-center pz:rounded-[7px] pz:hover:bg-accent pz:data-[state=on]:bg-muted pz:data-[state=on]:text-foreground",
        segmented:
          "pz:rounded-md pz:px-2.5 pz:py-1 pz:data-[state=on]:bg-card pz:data-[state=on]:text-foreground pz:data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.08)]",
      },
    },
    defaultVariants: { variant: "solid" },
  },
);

type Variant = VariantProps<typeof toggleGroupVariants>["variant"];

/** One choice of a few. Clicking the chosen item keeps it chosen. */
export function ToggleGroup<T extends string>({
  value,
  onValueChange,
  variant,
  className,
  items,
}: {
  value: T;
  onValueChange: (value: T) => void;
  variant?: Variant;
  className?: string;
  items: { value: T; label: ReactNode; title?: string }[];
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      data-slot="toggle-group"
      value={value}
      onValueChange={(next) => next && onValueChange(next as T)}
      className={cn(toggleGroupVariants({ variant, className }))}
    >
      {items.map((item) => (
        <ToggleGroupPrimitive.Item
          key={item.value}
          value={item.value}
          title={item.title}
          aria-label={item.title}
          data-slot="toggle-group-item"
          className={toggleGroupItemVariants({ variant })}
        >
          {item.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

/**
 * A small menu off a trigger. Not portalled: it renders inside .pz-root, so the
 * canvas's colors apply and a click in it counts as inside whatever holds it.
 */
export function Menu({
  trigger,
  items,
}: {
  trigger: ReactNode;
  items: { label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void }[];
}) {
  return (
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Content
        align="end"
        sideOffset={4}
        className="pz:z-10 pz:min-w-40 pz:rounded-[10px] pz:bg-card pz:p-1 pz:shadow-pop pz:outline-none pz:ring-1 pz:ring-black/5 pz:dark:ring-white/10"
        onPointerDown={(e) => e.stopPropagation()}
        // Esc closes the menu, not whatever holds it.
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <MenuPrimitive.Item
            key={item.label}
            onSelect={item.onSelect}
            className={cn(
              "pz:flex pz:h-[30px] pz:cursor-default pz:items-center pz:gap-2 pz:rounded-md pz:px-2 pz:outline-none pz:data-highlighted:bg-accent",
              item.danger && "pz:text-danger",
            )}
          >
            {item.icon}
            {item.label}
          </MenuPrimitive.Item>
        ))}
      </MenuPrimitive.Content>
    </MenuPrimitive.Root>
  );
}
