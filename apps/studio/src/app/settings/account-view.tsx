import { ApiError } from "@ponzu/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { DeleteAccountDialog } from "../../cloud/dialogs/account-dialogs.tsx";
import type { Person, Workspace } from "../../cloud/model.ts";
import { AccountSection } from "../../cloud/settings/account.tsx";
import type { Role } from "../../cloud/settings/members.ts";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";

/*
 * Settings › Account: who is signed in and through what, their teams, signing out, and deleting
 * the account. Deleting asks for the GitHub login typed out; while the person is the only admin
 * of a team others are in, the API refuses and the dialog says which team, and once it is done
 * the app signs out.
 */
export function AccountView({
  host,
  me,
  email,
  teams,
  onCreateTeam,
}: {
  host: Host;
  me: Person;
  email: string | null;
  teams: { workspace: Workspace; role: Role }[];
  onCreateTeam: () => void;
}) {
  const { mutations } = usePonzu();
  const remove = useMutation(mutations.deleteAccount());
  const [asking, setAsking] = useState(false);
  const refusal = remove.error instanceof ApiError ? remove.error : null;
  const teamsHeld = (
    (refusal?.details?.workspaces as { name?: unknown }[] | undefined) ?? []
  ).flatMap((w) => (typeof w.name === "string" ? [w.name] : []));
  const soleAdmin = refusal?.code === "sole_admin" ? (teamsHeld.length ? teamsHeld : true) : false;
  const error =
    remove.error && !soleAdmin
      ? refusal && refusal.status !== 0
        ? refusal.message
        : "Couldn't reach Ponzu, so your account wasn't deleted. Try again."
      : null;
  return (
    <>
      <AccountSection
        me={me}
        email={email}
        teams={teams}
        onSignOut={() => void host.session.signOut()}
        onCreateTeam={onCreateTeam}
        onDelete={() => {
          remove.reset();
          setAsking(true);
        }}
      />
      <DeleteAccountDialog
        open={asking}
        login={me.login}
        soleAdmin={soleAdmin}
        busy={remove.isPending}
        error={error}
        onCancel={() => setAsking(false)}
        onConfirm={() =>
          remove.mutate(me.login, {
            // Nothing of the account is left to show: the window goes back to signing in.
            onSuccess: () => void host.session.signOut(),
          })
        }
      />
    </>
  );
}
