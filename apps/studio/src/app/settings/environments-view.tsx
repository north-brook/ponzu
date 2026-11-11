import { ApiError } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { EnvironmentsSection } from "../../cloud/settings/environments.tsx";
import { usePonzu } from "../ponzu-query.tsx";
import { toEnvironment } from "./map.ts";
import { SectionUnavailable } from "./unavailable.tsx";

/*
 * Settings › Environments: per repo, the base its designs start from (Rebuild, for whoever can
 * push to it) and the secrets its sandboxes get, by name. Admins add, replace and remove them;
 * a value is written and never read back. A sandbox takes its secrets as it starts, so a change
 * reaches a design at its next start. Which repos are shown open is kept on this device.
 */

/** How long a refused change is said. */
const REFUSAL_MS = 6000;
const OPEN_KEY = "ponzu.settings.environments.open";

export function EnvironmentsView({ workspaceId }: { workspaceId: string }) {
  const { queries, mutations } = usePonzu();
  const answer = useQuery(queries.environments(workspaceId));
  const workspace = useQuery(queries.workspace(workspaceId));
  const rebuild = useMutation(mutations.rebuildEnvironment());
  const save = useMutation(mutations.saveSecret());
  const remove = useMutation(mutations.removeSecret());
  const [open, setOpen] = useState(() => loadOpen(workspaceId));
  const pushable = useMemo(
    () => new Set(workspace.data?.repos.filter((r) => r.canPush).map((r) => r.id) ?? []),
    [workspace.data],
  );
  const refused = rebuild.error ?? save.error ?? remove.error;
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => {
      rebuild.reset();
      save.reset();
      remove.reset();
    }, REFUSAL_MS);
    return () => clearTimeout(timer);
  }, [refused, rebuild.reset, save.reset, remove.reset]);

  if (!answer.data) {
    return answer.isError ? <SectionUnavailable onRetry={() => void answer.refetch()} /> : null;
  }
  return (
    <>
      <EnvironmentsSection
        environments={answer.data.repos.map(toEnvironment)}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          saveOpen(workspaceId, next);
        }}
        canEdit={answer.data.canManageSecrets}
        canRebuild={(repo) => pushable.has(repo.id)}
        note={
          answer.data.canManageSecrets
            ? "A design gets its repo's secrets as it starts, so a changed secret reaches it at its next start."
            : "Only an admin can change secrets. A design gets them as it starts."
        }
        onRebuild={(repo) => rebuild.mutate({ workspaceId, repoId: repo.id })}
        onSaveSecret={(repo, name, value) => {
          const env = answer.data.repos.find((r) => r.repo.id === repo.id);
          const replacing = env?.secrets.some((s) => s.name === name) ?? false;
          save.mutate({ workspaceId, repoId: repo.id, name, value, replacing });
        }}
        onRemoveSecret={(repo, name) => remove.mutate({ workspaceId, repoId: repo.id, name })}
      />
      {refused ? (
        <p role="alert" className="m-0 text-12 text-danger">
          {refused instanceof ApiError && refused.status !== 0
            ? refused.message
            : "Couldn't reach Ponzu, so nothing changed. Try again."}
        </p>
      ) : null}
    </>
  );
}

function loadOpen(workspaceId: string): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, unknown>;
    const open = saved[workspaceId];
    return Array.isArray(open) ? open.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveOpen(workspaceId: string, open: string[]): void {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, unknown>;
    localStorage.setItem(OPEN_KEY, JSON.stringify({ ...saved, [workspaceId]: open }));
  } catch {
    // Without storage, it is remembered while Settings is open.
  }
}
