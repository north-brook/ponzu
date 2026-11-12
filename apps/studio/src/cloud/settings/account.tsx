import { PlusSignIcon } from "@hugeicons/core-free-icons";
import type { Person, Workspace } from "../model.ts";
import { WorkspaceMark } from "../sidebar/workspace-menu.tsx";
import { Avatar } from "../ui/avatar.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { Switch } from "../ui/switch.tsx";
import type { Role } from "./members.ts";
import { QuietButton, Row, Section, TwoLine } from "./parts.tsx";

export interface AccountSectionProps {
  me: Person;
  email: string | null;
  /** The organizations the person is in, with their role in each. */
  teams: { workspace: Workspace; role: Role }[];
  onSignOut: () => void;
  onCreateTeam: () => void;
  /** Asks first: the wiring opens DeleteAccountDialog. Left out, there is no Danger zone. */
  onDelete?: () => void;
  /**
   * Share usage data, as the account says, and its toggle. Left out, there is no Usage data
   * section (an API that does not say).
   */
  usage?: {
    on: boolean;
    onChange: (on: boolean) => void;
    /** Turned on in a window that loaded nothing to report with: it starts at the next launch. */
    resumesNextLaunch: boolean;
  };
  /** Opens one of the site's pages in the browser: the policy, the terms. */
  onOpenLink?: (url: string) => void;
}

const ROLE_LABELS: Record<Role, string> = { admin: "Admin", member: "Member" };

/** The site's pages Account links to. */
export const ACCOUNT_LINKS = {
  analytics: "https://ponzu.design/privacy#analytics",
  privacy: "https://ponzu.design/privacy",
  terms: "https://ponzu.design/terms",
} as const;

const USAGE_LINE = "Usage, errors and screen recordings, with your work hidden.";

/** Who is signed in and through what, the teams they are in, and the way out. */
export function AccountSection({
  me,
  email,
  teams,
  onSignOut,
  onCreateTeam,
  onDelete,
  usage,
  onOpenLink,
}: AccountSectionProps) {
  const link = (url: string, label: string) =>
    onOpenLink ? (
      <button
        type="button"
        onClick={() => onOpenLink(url)}
        className="cursor-default rounded-4 text-faint underline-offset-2 outline-none focus-ring hover:text-muted hover:underline"
      >
        {label}
      </button>
    ) : null;
  return (
    <>
      <div className="flex items-center gap-3.5">
        <Avatar person={me} size={56} className="shadow-[0_0_0_1px_var(--c-rule)]" />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="truncate font-display font-semibold text-18 text-ink leading-[1.2]">
            {me.name}
          </span>
          {email ? <span className="truncate text-13 text-muted">{email}</span> : null}
        </div>
      </div>
      <Section
        label="Signed in with"
        note="Your name, avatar and email come from GitHub. Change them there."
      >
        <Row
          leading={<GithubMark size={16} className="text-ink" />}
          trailing={<QuietButton onClick={onSignOut}>Sign out</QuietButton>}
        >
          <TwoLine title="GitHub" line={me.login} />
        </Row>
      </Section>
      <Section label="Teams">
        {teams.map(({ workspace, role }) => (
          <Row
            key={workspace.id}
            leading={<WorkspaceMark workspace={workspace} />}
            trailing={<span className="text-13 text-muted">{ROLE_LABELS[role]}</span>}
          >
            <span className="truncate font-medium text-13 text-ink">{workspace.name}</span>
          </Row>
        ))}
        <Row>
          <button
            type="button"
            onClick={onCreateTeam}
            className="-mx-1 flex cursor-default items-center gap-2.5 rounded-6 px-1 py-1 text-13 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-ink"
          >
            <Icon icon={PlusSignIcon} step="control" />
            Create a team
          </button>
        </Row>
      </Section>
      {usage ? (
        <Section label="Usage data" note={link(ACCOUNT_LINKS.analytics, "Learn more")}>
          <Row
            trailing={
              <Switch
                label="Share usage data"
                checked={usage.on}
                onCheckedChange={usage.onChange}
              />
            }
          >
            <TwoLine
              title="Share usage data"
              line={
                usage.on && usage.resumesNextLaunch
                  ? "Recording resumes next time Ponzu opens"
                  : USAGE_LINE
              }
            />
          </Row>
        </Section>
      ) : null}
      {onDelete ? (
        <Section label="Danger zone">
          <Row
            trailing={
              <button
                type="button"
                onClick={onDelete}
                className="cursor-default rounded-4 font-medium text-13 text-danger underline-offset-2 outline-none focus-ring hover:underline"
              >
                Delete
              </button>
            }
          >
            <span className="text-13 text-muted">Delete account</span>
          </Row>
        </Section>
      ) : null}
      {onOpenLink ? (
        <p className="m-0 flex items-center gap-1.5 text-12 text-faint">
          {link(ACCOUNT_LINKS.privacy, "Privacy")}
          <span aria-hidden="true">·</span>
          {link(ACCOUNT_LINKS.terms, "Terms")}
        </p>
      ) : null}
    </>
  );
}
