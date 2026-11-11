/*
 * shadcn/ui's avatar, themed with our tokens. Radix draws the picture only once it has loaded, so
 * one that fails shows the person's initial instead of a broken image. While it loads the circle
 * keeps its place and its ring, empty, as a plain image did, rather than flashing the initial.
 *
 * Changed from shadcn's: the root takes no box of its own (`display: contents`), so the circle,
 * the picture or its fallback, is what a caller places, sizes and rings, as it was an `<img>`.
 */
import { Avatar as AvatarPrimitive } from "radix-ui";
import { type ComponentProps, type CSSProperties, useState } from "react";
import type { Person } from "../model.ts";
import { cn } from "./cn.ts";

type Status = "idle" | "loading" | "loaded" | "error";

const circleClass = "block shrink-0 rounded-pill";

function AvatarRoot({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root data-slot="avatar" className={cn("contents", className)} {...props} />
  );
}

function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      draggable={false}
      className={cn(circleClass, "object-cover", className)}
      {...props}
    />
  );
}

function AvatarFallback({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(circleClass, "grid place-items-center font-semibold text-muted", className)}
      {...props}
    />
  );
}

/**
 * A person's round avatar. `ring` draws a 1.5px hairline of the ground it sits on, so
 * overlapping avatars stay apart. Without a picture, or when it fails, it shows their initial.
 */
export function Avatar({
  person,
  size,
  ring,
  className,
  style,
}: {
  person: Person;
  size: number;
  /** The ground's token: `chrome` in the chrome and sidebar, `surface` in popovers. */
  ring?: "chrome" | "surface";
  className?: string;
  style?: CSSProperties;
}) {
  const [status, setStatus] = useState<Status>(person.avatarUrl ? "loading" : "idle");
  const sized: CSSProperties = {
    width: size,
    height: size,
    boxShadow: ring ? `0 0 0 1.5px var(--c-${ring})` : undefined,
    ...style,
  };
  const initial = !person.avatarUrl || status === "error";
  return (
    <AvatarRoot
      // The visual check waits for pictures that are still loading (scripts/visual-lib.ts).
      data-status={person.avatarUrl ? status : undefined}
    >
      {person.avatarUrl ? (
        <AvatarImage
          src={person.avatarUrl}
          alt=""
          className={className}
          style={sized}
          onLoadingStatusChange={setStatus}
        />
      ) : null}
      {/* Radix shows it until the picture has loaded: empty while it loads. */}
      <AvatarFallback
        aria-hidden
        className={cn(initial && "bg-chip", className)}
        style={{ ...sized, fontSize: Math.round(size * 0.45) }}
      >
        {initial ? person.name.trim().charAt(0).toUpperCase() : null}
      </AvatarFallback>
    </AvatarRoot>
  );
}

/** People's avatars overlapping left to right, each `overlap` px over the one before. */
export function AvatarStack({
  people,
  size,
  overlap,
  ring,
}: {
  people: Person[];
  size: number;
  overlap: number;
  ring: "chrome" | "surface";
}) {
  return (
    <span data-slot="avatar-group" className="flex">
      {people.map((person, i) => (
        <Avatar
          key={person.id}
          person={person}
          size={size}
          ring={ring}
          style={i > 0 ? { marginLeft: -overlap } : undefined}
        />
      ))}
    </span>
  );
}

export { AvatarFallback, AvatarImage, AvatarRoot };
