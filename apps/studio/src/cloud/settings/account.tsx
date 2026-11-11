import { Add01Icon } from "@hugeicons/core-free-icons";
import type { Person, Workspace } from "../model.ts";
import { WorkspaceMark } from "../sidebar/workspace-menu.tsx";
import { Avatar } from "../ui/avatar.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
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
}

const ROLE_LABELS: Record<Role, string> = { admin: "Admin", member: "Member" };

/** Who is signed in and through what, the teams they are in, and the way out. */
export function AccountSection({
  me,
  email,
  teams,
  onSignOut,
  onCreateTeam,
  onDelete,
}: AccountSectionProps) {
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
            <Icon icon={Add01Icon} size={16} stroke={1.8} className="text-faint" />
            Create a team
          </button>
        </Row>
      </Section>
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
    </>
  );
}
