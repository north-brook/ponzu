import { ArrowDown01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { Workspace } from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Button } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu.tsx";
import { Tip } from "../ui/tooltip.tsx";
import { LOCKED_REASONS, type Member, type Role, roleEdit, sortMembers } from "./members.ts";
import { Row, Section, TwoLine } from "./parts.tsx";

export interface MembersSectionProps {
  workspace: Workspace;
  members: Member[];
  meId: string;
  onRoleChange: (member: Member, role: Role) => void;
  /** The organization's people on GitHub. */
  onManage: () => void;
  /** The last sync with GitHub failed: the list is as it was. */
  syncFailed: boolean;
}

const ROLES: { value: Role; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

/**
 * Who is in the workspace, and each person's role. Membership is GitHub's: everyone who can
 * reach the organization's repos is in, so there is nothing here to invite or remove. An admin
 * sets roles; everyone else reads them.
 */
export function MembersSection({
  workspace,
  members,
  meId,
  onRoleChange,
  onManage,
  syncFailed,
}: MembersSectionProps) {
  const viewerIsAdmin = members.some((m) => m.person.id === meId && m.role === "admin");
  return (
    <>
      <Section label="GitHub">
        <Row
          leading={<GithubMark size={18} className="text-ink" />}
          trailing={
            <button
              type="button"
              onClick={onManage}
              className="flex cursor-default items-center gap-1 rounded-4 text-12 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-ink"
            >
              Manage
              <Icon icon={ArrowUpRight01Icon} size={11} stroke={2} className="text-icon-soft" />
            </button>
          }
        >
          <TwoLine
            title={workspace.login}
            line={`Everyone with access to its repos is in ${workspace.name}`}
          />
        </Row>
      </Section>
      <Section
        label="People"
        note={syncFailed ? "Couldn't reach GitHub. This is who was in it last time." : undefined}
      >
        {sortMembers(members).map((member) => (
          <Row
            key={member.person.id}
            leading={
              <Avatar
                person={member.person}
                size={28}
                className="shadow-[0_0_0_1px_var(--c-rule)]"
              />
            }
            trailing={
              <RolePicker
                member={member}
                edit={roleEdit(member, members, viewerIsAdmin)}
                workspace={workspace}
                onChange={(role) => onRoleChange(member, role)}
              />
            }
          >
            <TwoLine
              title={
                <>
                  {member.person.name}
                  {member.person.id === meId ? (
                    <span className="font-normal text-12 text-faint"> (you)</span>
                  ) : null}
                </>
              }
              line={member.person.login}
            />
          </Row>
        ))}
      </Section>
    </>
  );
}

/** A person's role: a compact picker for an admin, plain text otherwise or when it is locked. */
function RolePicker({
  member,
  edit,
  workspace,
  onChange,
}: {
  member: Member;
  edit: ReturnType<typeof roleEdit>;
  workspace: Workspace;
  onChange: (role: Role) => void;
}) {
  const label = member.role === "admin" ? "Admin" : "Member";
  if (!edit.editable) {
    if (edit.reason === "not_admin") {
      return <span className="flex h-6 items-center text-12 text-muted">{label}</span>;
    }
    // Where the chevron would be stays empty, so a locked role lines up with the pickers.
    const text = (
      <span className="flex h-6 items-center pr-[18px] pl-2 text-12 text-muted">{label}</span>
    );
    return (
      <Tip label={LOCKED_REASONS[edit.reason](workspace.login)} side="top">
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the reason too */}
        <span tabIndex={0} className="rounded-6 outline-none focus-ring">
          {text}
        </span>
      </Tip>
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          variant="quiet"
          aria-label={`Role of ${member.person.name}: ${label}`}
          className="h-6 gap-1 rounded-6 pr-1 pl-2 font-normal text-12 text-muted"
        >
          {label}
          <Icon icon={ArrowDown01Icon} size={10} stroke={2.2} className="text-faint" />
        </Button>
      </MenuTrigger>
      <MenuContent width={160} side="bottom" align="end" sideOffset={4}>
        <MenuRadioGroup value={member.role} onValueChange={(role) => onChange(role as Role)}>
          {ROLES.map((r) => (
            <MenuRadioItem key={r.value} value={r.value}>
              {r.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
