import { cva, type VariantProps } from "class-variance-authority";
import { type ClassValue, clsx } from "clsx";
import {
  DropdownMenu as MenuPrimitive,
  ToggleGroup as ToggleGroupPrimitive,
  Tooltip as TooltipPrimitive,
} from "radix-ui";
import {
  type ComponentProps,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useRef,
} from "react";
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
        "icon-sm": "pz:size-6 pz:rounded-md",
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

/** Whether a TipProvider is above, so a lone Tip knows to bring its own. */
const TipScope = createContext(false);

/**
 * Shares one hover delay across the tips inside it: once one has shown, the
 * next shows straight away as the pointer moves along a toolbar.
 */
export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={300} skipDelayDuration={300} disableHoverableContent>
      <TipScope.Provider value={true}>{children}</TipScope.Provider>
    </TooltipPrimitive.Provider>
  );
}

/**
 * A short label for a control, and its shortcut as key caps, shown on hover.
 * The child is the trigger. The tip renders in a portal, outside `.pz-root`,
 * so it can't use the canvas's color variables; it is dark in either theme.
 */
export function Tip({
  label,
  keys,
  side = "top",
  children,
}: {
  label: string;
  keys?: string[];
  side?: "top" | "bottom";
  children: ReactElement;
}) {
  const tip = (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={8}
          collisionPadding={8}
          data-slot="tip"
          className="pz-tip pz:z-50 pz:flex pz:h-[26px] pz:select-none pz:items-center pz:gap-2 pz:whitespace-nowrap pz:rounded-[7px] pz:bg-[#1c1c1b] pz:pr-1.5 pz:pl-[9px] pz:text-[12px] pz:text-white pz:leading-4 pz:antialiased pz:shadow-[0_0_0_0.5px_rgba(255,255,255,0.1),0_4px_14px_rgba(0,0,0,0.18)]"
        >
          {label}
          {keys?.length ? (
            <span className="pz:flex pz:gap-0.5">
              {keys.map((k) => (
                <kbd
                  key={k}
                  className="pz:min-w-4 pz:rounded pz:bg-white/15 pz:px-1 pz:text-center pz:text-[11px] pz:text-white/85 pz:leading-4 pz:[font-family:inherit]"
                >
                  {k}
                </kbd>
              ))}
            </span>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return useContext(TipScope) ? tip : <TipProvider>{tip}</TipProvider>;
}

const toggleGroupVariants = cva("pz:flex pz:gap-0.5 pz:p-0.5", {
  variants: {
    variant: {
      /** The mode switcher: the chosen one gets a soft chip. */
      solid: "pz:rounded-[9px]",
      /** A segmented control: the chosen one lifts. */
      segmented: "pz:rounded-lg pz:bg-muted",
      /** Tools on a floating bar: the chosen one is a raised chip. */
      raised: "pz:p-0",
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
          "pz:grid pz:h-[26px] pz:w-[30px] pz:place-items-center pz:rounded-[7px] pz:hover:bg-accent pz:aria-checked:bg-muted pz:aria-checked:text-foreground",
        segmented:
          "pz:rounded-md pz:px-2.5 pz:py-1 pz:aria-checked:bg-card pz:aria-checked:text-foreground pz:aria-checked:shadow-[0_1px_2px_rgba(0,0,0,0.08)]",
        raised:
          "pz:grid pz:size-7 pz:place-items-center pz:rounded-lg pz:hover:bg-accent pz:aria-checked:bg-raised pz:aria-checked:text-foreground pz:aria-checked:shadow-raised",
      },
    },
    defaultVariants: { variant: "solid" },
  },
);

type Variant = VariantProps<typeof toggleGroupVariants>["variant"];

/**
 * One choice of a few. Clicking the chosen item keeps it chosen. The chosen
 * item is styled by aria-checked, not data-state: a Tip's trigger sets its own
 * data-state on the same element. An item with
 * `keys` gets a Tip of its title and shortcut; one without uses a native title.
 */
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
  items: { value: T; label: ReactNode; title?: string; keys?: string[] }[];
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      data-slot="toggle-group"
      value={value}
      onValueChange={(next) => next && onValueChange(next as T)}
      className={cn(toggleGroupVariants({ variant, className }))}
    >
      {items.map((item) => {
        const tipped = Boolean(item.keys && item.title);
        const control = (
          <ToggleGroupPrimitive.Item
            key={item.value}
            value={item.value}
            title={tipped ? undefined : item.title}
            aria-label={item.title}
            data-slot="toggle-group-item"
            className={toggleGroupItemVariants({ variant })}
          >
            {item.label}
          </ToggleGroupPrimitive.Item>
        );
        return tipped ? (
          <Tip key={item.value} label={item.title!} keys={item.keys}>
            {control}
          </Tip>
        ) : (
          control
        );
      })}
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
  const chose = useRef(false);
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
        // After a choice, focus stays where the choice put it (an edit field, say)
        // instead of snapping back to the trigger.
        onCloseAutoFocus={(e) => {
          if (chose.current) e.preventDefault();
          chose.current = false;
        }}
      >
        {items.map((item) => (
          <MenuPrimitive.Item
            key={item.label}
            onSelect={() => {
              chose.current = true;
              item.onSelect();
            }}
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
