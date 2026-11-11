import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { shortDate } from "../claude.ts";
import type { Repo } from "../model.ts";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { REPO_ICON } from "../ui/project-icons.ts";
import { Row, Section, TwoLine } from "./parts.tsx";

/** Ponzu's GitHub App on a workspace's account. */
export interface Installation {
  state: "installed" | "suspended" | "not_installed";
  accountLogin: string;
  /** Who installed it, when GitHub said. */
  installedBy: string | null;
  installedAt: string | null;
}

export interface GithubSectionProps {
  installation: Installation;
  /** The repos Ponzu can open here, pushed-to lately first. */
  repos: Repo[];
  /** The installation's settings on GitHub: where repos are chosen. */
  onManage: () => void;
  /** GitHub's install page, when the App is not installed. */
  onInstall: () => void;
}

/**
 * The GitHub App on the workspace's account and the repos it lets Ponzu open. Repos are chosen on
 * GitHub; this is the way there.
 */
export function GithubSection({ installation, repos, onManage, onInstall }: GithubSectionProps) {
  const { state, accountLogin, installedBy, installedAt } = installation;
  const title = {
    installed: `Installed on ${accountLogin}`,
    suspended: `Suspended on ${accountLogin}`,
    not_installed: `Not installed on ${accountLogin}`,
  }[state];
  const line =
    state === "installed"
      ? [installedBy && `by ${installedBy}`, installedAt && shortDate(installedAt)]
          .filter(Boolean)
          .join(" · ")
      : state === "suspended"
        ? "Nobody can open its repos in Ponzu until it is unsuspended."
        : null;
  return (
    <>
      <Section label="GitHub App">
        <Row
          leading={<GithubMark size={18} className="text-ink" />}
          trailing={
            <button
              type="button"
              onClick={state === "not_installed" ? onInstall : onManage}
              className="flex cursor-default items-center gap-[5px] rounded-4 font-medium text-13 text-ink outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-muted"
            >
              {state === "not_installed" ? "Install on GitHub" : "Manage on GitHub"}
              <Icon icon={ArrowUpRight01Icon} size={12} stroke={2} className="text-muted" />
            </button>
          }
        >
          <TwoLine title={title} line={line || null} />
        </Row>
      </Section>
      {state === "installed" ? (
        <Section label="Repositories Ponzu can open">
          {repos.length ? (
            repos.map((repo) => (
              <Row
                key={repo.id}
                leading={<Icon icon={REPO_ICON} size={16} stroke={1.6} className="text-muted" />}
              >
                <TwoLine title={repo.name} line={`${repo.owner}/${repo.name}`} />
              </Row>
            ))
          ) : (
            <Row>
              <span className="text-13 text-muted">
                No repositories yet. Choose some on GitHub.
              </span>
            </Row>
          )}
        </Section>
      ) : null}
    </>
  );
}
