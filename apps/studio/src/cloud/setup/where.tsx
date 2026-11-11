import { Tick02Icon } from "@hugeicons/core-free-icons";
import { monogramColor } from "../sidebar/workspace-menu.tsx";
import { cn } from "../ui/cn.ts";
import { Icon } from "../ui/icon.tsx";
import { canContinue, type GithubAccount } from "./setup.ts";
import {
  LeaveLink,
  RowButton,
  SetupCard,
  SetupRow,
  StepButton,
  StepLayout,
  Waiting,
} from "./step.tsx";

/** What came back from GitHub's install page when it was not an installation. */
export type InstallNotice = "requested" | "failed";

export interface WhereStepProps {
  /** The rows, as `GET /v1/github/accounts` gives them; "loading" until the first answer. */
  accounts: GithubAccount[] | "loading" | "failed";
  /** The account whose install page is open: its row waits for the person to come back. */
  settingUp: number | null;
  notice: InstallNotice | null;
  onSetUp: (account: GithubAccount) => void;
  /** GitHub's install page, for an organization this list can't show. */
  onOtherOrganization: () => void;
  onRetry: () => void;
  onContinue: () => void;
  continuing?: boolean;
}

/**
 * "Where do you design?": the person's own account, then each organization where Ponzu is
 * already installed. Set up installs Ponzu's GitHub App on the account; when the person is back
 * from GitHub the row turns Ready. Any other organization is set up from GitHub's install page.
 */
export function WhereStep({
  accounts,
  settingUp,
  notice,
  onSetUp,
  onOtherOrganization,
  onRetry,
  onContinue,
  continuing = false,
}: WhereStepProps) {
  const list = Array.isArray(accounts) ? accounts : null;
  return (
    <StepLayout
      progress={1}
      title="Where do you design?"
      body="Design on your real product, with your team, and ship it as a pull request. Pick where your code lives."
      actions={
        <StepButton onClick={onContinue} disabled={!list || !canContinue(list)} busy={continuing}>
          Continue
        </StepButton>
      }
    >
      {accounts === "loading" ? (
        <SetupCard className="h-[57px] items-center justify-center">
          <Waiting size={13} label="Loading your accounts" />
        </SetupCard>
      ) : accounts === "failed" ? (
        <SetupCard className="h-[57px] flex-row items-center justify-center gap-3">
          <span className="text-13 text-muted">Couldn't reach GitHub.</span>
          <RowButton tone="raised" onClick={onRetry}>
            Try again
          </RowButton>
        </SetupCard>
      ) : (
        // When the window can't hold every row, the card scrolls inside itself: the link and
        // Continue stay on screen below it.
        <SetupCard className="min-h-0">
          <div className="scroll-fade flex min-h-0 flex-col overflow-y-auto overscroll-contain">
            {accounts.map((account) => (
              <AccountRow
                key={account.githubAccountId}
                account={account}
                waiting={settingUp === account.githubAccountId}
                onSetUp={() => onSetUp(account)}
              />
            ))}
          </div>
        </SetupCard>
      )}
      {notice ? (
        <p
          role="status"
          className={cn(
            "m-0 pt-3.5 text-center text-12",
            notice === "failed" ? "text-danger" : "text-muted",
          )}
        >
          {notice === "requested"
            ? "Sent to the organization's owners. It shows up here once one approves."
            : "That didn't finish on GitHub. Try again."}
        </p>
      ) : null}
      <div className={cn("flex justify-center", notice ? "pt-2" : "pt-3.5")}>
        <LeaveLink onClick={onOtherOrganization}>
          Don't see an organization? Grant access on GitHub
        </LeaveLink>
      </div>
    </StepLayout>
  );
}

function AccountRow({
  account,
  waiting,
  onSetUp,
}: {
  account: GithubAccount;
  waiting: boolean;
  onSetUp: () => void;
}) {
  const personal = account.kind === "personal";
  // The person's own account is "Personal" over their login; an organization is its name over
  // its login, or just the login when it has no other name.
  const title = personal ? "Personal" : account.name || account.login;
  const people =
    !personal && account.status === "ready" && account.memberCount !== null
      ? ` · ${account.memberCount} ${account.memberCount === 1 ? "person" : "people"}`
      : "";
  const line = personal || title !== account.login ? `${account.login}${people}` : people.slice(3);
  return (
    <SetupRow mark={<AccountMark account={account} />} title={title} line={line || null}>
      {account.status === "not_installed" ? (
        <RowButton tone="raised" leaves busy={waiting} onClick={onSetUp}>
          Set up
        </RowButton>
      ) : account.suspended ? (
        <span className="font-medium text-12 text-muted">Suspended on GitHub</span>
      ) : (
        <span className="flex items-center gap-1.5 font-medium text-12 text-muted">
          <Icon icon={Tick02Icon} size={14} stroke={2.2} className="text-ink" />
          Ready
        </span>
      )}
    </SetupRow>
  );
}

/** An account's 32px picture: round for a person, a rounded square for an organization. */
function AccountMark({ account }: { account: GithubAccount }) {
  const shape = account.kind === "personal" ? "rounded-pill" : "rounded-8";
  if (account.avatarUrl) {
    return (
      <img
        src={account.avatarUrl}
        alt=""
        draggable={false}
        className={cn("block size-8 shrink-0 object-cover shadow-[0_0_0_1px_var(--c-rule)]", shape)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center font-display font-semibold text-14 leading-none",
        shape,
      )}
      style={{ background: monogramColor(String(account.githubAccountId)), color: "#ffffff" }}
    >
      {(account.name || account.login).charAt(0).toUpperCase()}
    </span>
  );
}
