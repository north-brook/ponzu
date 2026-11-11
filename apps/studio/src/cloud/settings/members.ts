import type { Person } from "../model.ts";

/*
 * Who is in a workspace is GitHub's to say; Ponzu keeps only each person's role. These are the
 * API's rules for changing one (apps/api, PATCH /v1/workspaces/:id/members/:userId), so the
 * picker offers only what the API will take.
 */

export type Role = "admin" | "member";

export interface Member {
  person: Person;
  role: Role;
  /** Owns the account on GitHub: an Admin at every sync, whom nobody can make a Member. */
  owner: boolean;
}

/** Whether `member`'s role can be changed by the viewer, and if not, why not. */
export type RoleEdit =
  | { editable: true }
  | { editable: false; reason: "not_admin" | "owner" | "last_admin" };

export function roleEdit(member: Member, members: Member[], viewerIsAdmin: boolean): RoleEdit {
  if (!viewerIsAdmin) return { editable: false, reason: "not_admin" };
  if (member.role !== "admin") return { editable: true };
  if (member.owner) return { editable: false, reason: "owner" };
  const admins = members.filter((m) => m.role === "admin").length;
  return admins > 1 ? { editable: true } : { editable: false, reason: "last_admin" };
}

/** Why a disabled picker can't be changed, as its tip says it. */
export const LOCKED_REASONS: Record<"owner" | "last_admin", (workspace: string) => string> = {
  owner: (workspace) => `Owns ${workspace} on GitHub`,
  last_admin: () => "A workspace needs an admin",
};

/** Admins first, then by name. */
export function sortMembers(members: Member[]): Member[] {
  return [...members].sort(
    (a, b) =>
      Number(b.role === "admin") - Number(a.role === "admin") ||
      a.person.name.localeCompare(b.person.name),
  );
}
