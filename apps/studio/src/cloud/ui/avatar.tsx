import type { CSSProperties } from "react";
import type { Person } from "../model.ts";
import { cn } from "./cn.ts";

/**
 * A person's round avatar. `ring` draws a 1.5px hairline of the ground it sits on, so
 * overlapping avatars stay apart. Without a picture it shows their initial.
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
  const sized: CSSProperties = {
    width: size,
    height: size,
    boxShadow: ring ? `0 0 0 1.5px var(--c-${ring})` : undefined,
    ...style,
  };
  const classes = cn("block shrink-0 rounded-pill object-cover", className);
  if (person.avatarUrl) {
    return (
      <img src={person.avatarUrl} alt="" draggable={false} className={classes} style={sized} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(classes, "grid place-items-center bg-chip font-semibold text-muted")}
      style={{ ...sized, fontSize: Math.round(size * 0.45) }}
    >
      {person.name.trim().charAt(0).toUpperCase()}
    </span>
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
    <span className="flex">
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
