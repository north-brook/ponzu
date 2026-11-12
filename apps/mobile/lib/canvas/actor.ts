import type { Profile } from "@ponzu/client";
import type { Actor } from "@ponzu/core";

/**
 * The signed-in person as the API stamps their ops, and as their comments name them here
 * until the API's version comes back.
 */
export function actorOf(person: Pick<Profile, "id" | "name" | "githubLogin" | "avatarUrl">): Actor {
  return {
    kind: "user",
    id: person.id,
    name: person.name ?? person.githubLogin,
    ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
  };
}
