import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { Workspace } from "../model.ts";
import { Avatar } from "../ui/avatar.tsx";
import { Button } from "../ui/button.tsx";
import { cn } from "../ui/cn.ts";
import { ExternalLink } from "../ui/external-link.tsx";
import { Icon } from "../ui/icon.tsx";
import { GithubMark } from "../ui/marks.tsx";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu.tsx";
import { Tip } from "../ui/tooltip.tsx";
import {
  LOCKED_REASONS,
  type Member,
  NOT_JOINED,
  type Role,
  roleEdit,
  sortMembers,
} from "./members.ts";
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
  /** Why the last role change didn't happen, in the API's words. */
  refusal?: string | null;
}

const ROLES: { value: Role; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

/**
 * Who is in the workspace, and each person's role. Membership is GitHub's: everyone who can
 * reach the organization's repos is in, so there is nothing here to invite or remove. An admin
 * sets roles; everyone else reads them. Someone who hasn't opened Ponzu yet is listed too,
 * quieter, with a note where a role would be: they have none until they do.
 */
export function MembersSection({
  workspace,
  members,
  meId,
  onRoleChange,
  onManage,
  syncFailed,
  refusal = null,
}: MembersSectionProps) {
  const viewerIsAdmin = members.some((m) => m.person.id === meId && m.role === "admin");
  return (
    <>
      <Section label="GitHub">
        <Row
          leading={<GithubMark size={18} className="text-ink" />}
          trailing={
            <ExternalLink onClick={onManage} className="gap-1 text-12">
              Manage
            </ExternalLink>
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
        note={
          refusal ? (
            <span role="alert" className="text-danger">
              {refusal}
            </span>
          ) : syncFailed ? (
            "Couldn't reach GitHub. This is who was in it last time."
          ) : undefined
        }
      >
        {sortMembers(members).map((member) => (
          <Row
            key={member.person.id}
            leading={
              <Avatar
                person={member.person}
                size={28}
                className={cn("shadow-[0_0_0_1px_var(--c-rule)]", !member.joined && "opacity-50")}
              />
            }
            trailing={
              member.joined ? (
                <RolePicker
                  member={member}
                  edit={roleEdit(member, members, viewerIsAdmin)}
                  workspace={workspace}
                  onChange={(role) => onRoleChange(member, role)}
                />
              ) : (
                <span className="flex h-6 items-center text-12 text-faint">{NOT_JOINED}</span>
              )
            }
          >
            <TwoLine
              title={
                member.joined ? (
                  <>
                    {member.person.name}
                    {member.person.id === meId ? (
                      <span className="font-normal text-12 text-faint"> (you)</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted">{member.person.name}</span>
                )
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
  member: Extract<Member, { joined: true }>;
  edit: ReturnType<typeof roleEdit>;
  workspace: Workspace;
  onChange: (role: Role) => void;
}) {
  const label = member.role === "admin" ? "Admin" : "Member";
  if (!edit.editable) {
    if (edit.reason === "not_admin" || edit.reason === "not_joined") {
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
          <Icon icon={ArrowDown01Icon} step="meta" />
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
