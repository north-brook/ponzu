import { ApiError } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Workspace } from "../../cloud/model.ts";
import { MembersSection } from "../../cloud/settings/members.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { peopleUrl, toMembers } from "./map.ts";

/*
 * Settings › Members: who GitHub says is in the workspace, and each one's role, which an admin
 * sets here. The API holds to the rules (an owner on GitHub stays an admin; a workspace keeps
 * one), the picker offers only what it takes, and a refusal is said under the list, in red,
 * for a few seconds.
 */

/** How long a refused role change is said. */
const REFUSAL_MS = 6000;

export function MembersView({
  host,
  workspace,
  meId,
}: {
  host: Host;
  workspace: Workspace;
  meId: string;
}) {
  const { queries, mutations } = usePonzu();
  const view = useQuery(queries.workspace(workspace.id));
  const setRole = useMutation(mutations.setRole());
  const refused = setRole.error;
  const { reset } = setRole;
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(reset, REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refused, reset]);
  if (!view.data) return null;
  return (
    <MembersSection
      workspace={workspace}
      members={toMembers(view.data)}
      meId={meId}
      onRoleChange={(member, role) =>
        setRole.mutate({ workspaceId: workspace.id, userId: member.person.id, role })
      }
      onManage={() => host.openExternal(peopleUrl(workspace.login))}
      syncFailed={view.isError}
      refusal={
        refused
          ? refused instanceof ApiError && refused.status !== 0
            ? refused.message
            : "Couldn't reach Ponzu, so that role didn't change. Try again."
          : null
      }
    />
  );
}
