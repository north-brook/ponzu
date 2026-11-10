import type { User } from "@ponzu/db";
import { z } from "zod";

/** A person as the apps show them. The shape `/v1/auth/exchange` and `/v1/me` both answer with. */
export const Profile = z.object({
  id: z.string(),
  githubLogin: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export function toProfile(user: User): z.input<typeof Profile> {
  return {
    id: user.id,
    githubLogin: user.githubLogin,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}
