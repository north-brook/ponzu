import { useMutation, useQuery } from "@tanstack/react-query";
import { GithubSection } from "../../cloud/settings/github.tsx";
import type { Host } from "../host.ts";
import { toRepo } from "../map.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { installationUrl, toInstallation } from "./map.ts";

/*
 * Settings › GitHub: the App on the workspace's account (installed, suspended or not there) and
 * the repos it lets Ponzu open, pushed to lately first. Repos are chosen on GitHub: Manage on
 * GitHub goes to the installation's settings, Install on GitHub to its install page.
 */
export function GithubView({ host, workspaceId }: { host: Host; workspaceId: string }) {
  const { queries, mutations } = usePonzu();
  const view = useQuery(queries.workspace(workspaceId));
  const installLink = useMutation(mutations.installLink());
  if (!view.data) return null;
  const data = view.data;
  const manage = installationUrl(data);
  return (
    <GithubSection
      installation={toInstallation(data)}
      repos={data.repos.map((repo) => toRepo(repo.id, repo.fullName))}
      onManage={() => {
        if (manage) host.openExternal(manage);
      }}
      onInstall={() =>
        installLink.mutate(
          { client: "mac", githubAccountId: data.workspace.githubAccountId },
          { onSuccess: ({ url }) => host.openExternal(url) },
        )
      }
    />
  );
}
