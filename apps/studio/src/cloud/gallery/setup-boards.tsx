/* What each guided setup, Settings and dialog composition in setup-compositions.ts draws. */
import { type ReactNode, useState } from "react";
import {
  ClaudeSignedOutDialog,
  DeleteAccountDialog,
  DisconnectClaudeDialog,
} from "../dialogs/account-dialogs.tsx";
import {
  AddCardDialog,
  CapReachedDialog,
  type CardStatus,
  FreeCreditsDialog,
  PaymentFailedDialog,
} from "../dialogs/billing-dialogs.tsx";
import type { ClaudeCardState } from "../setup/claude-card.tsx";
import * as f from "./fixtures.ts";
import { CreateHarness, Harness } from "./harness.tsx";
import * as s from "./setup-fixtures.ts";
import {
  type SettingsData,
  SettingsWindow,
  SetupHarness,
  SOLO_SETTINGS,
  TEAM_SETTINGS,
  useClaudeCard,
} from "./setup-harness.tsx";

const ignore = () => {};
const PROMPT = "Try a darker footer with the newsletter signup";
const choose = { mode: "choose", starting: false, failed: false } as const;

/** The create page with a prompt typed, behind a dialog that a send opened. */
function OnSend({ children }: { children: (dismiss: () => void, open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Harness canvases={f.soloCanvases} openId={null}>
        <CreateHarness initialPrompt={PROMPT} />
      </Harness>
      {children(() => setOpen(false), open)}
    </>
  );
}

/**
 * Free credits used up, on send: the cap and the button that opens Stripe's page in the browser
 * (no card fields in the app: see billing-dialogs.tsx), waiting on it, or back with why not.
 */
function FreeCredits({
  canAddCard = true,
  status = "idle",
  error = null,
}: {
  canAddCard?: boolean;
  status?: CardStatus;
  error?: string | null;
}) {
  return (
    <OnSend>
      {(dismiss, open) => (
        <FreeCreditsDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={f.thistlewick.name}
          canAddCard={canAddCard}
          defaultCapUsd={100}
          status={status}
          error={error}
          onSubmit={ignore}
          onCancel={ignore}
        />
      )}
    </OnSend>
  );
}

/** Plan and usage once billing is on, before a card: no cap row, the bar the free credits alone. */
const NO_CARD_SETTINGS = { ...TEAM_SETTINGS, usage: { ...s.freeUsage, notBilled: false } };

function ClaudeSignedOut({ start = choose }: { start?: ClaudeCardState }) {
  const props = useClaudeCard(start, ignore);
  return (
    <OnSend>
      {(dismiss, open) => <ClaudeSignedOutDialog open={open} onDismiss={dismiss} card={props} />}
    </OnSend>
  );
}

export const SETUP_BOARDS: Record<string, () => ReactNode> = {
  "setup-sign-in": () => <SetupHarness start={{ step: "sign_in" }} />,
  "setup-sign-in-waiting": () => <SetupHarness start={{ step: "sign_in", state: "waiting" }} />,
  "setup-sign-in-failed": () => <SetupHarness start={{ step: "sign_in", state: "failed" }} />,
  "setup-where": () => <SetupHarness start={{ step: "where", accounts: s.accounts }} />,
  "setup-where-nothing-ready": () => (
    <SetupHarness start={{ step: "where", accounts: s.nothingReady }} />
  ),
  "setup-where-setting-up": () => (
    <SetupHarness
      start={{
        step: "where",
        accounts: s.nothingReady,
        settingUp: s.personalAccount.githubAccountId,
      }}
    />
  ),
  "setup-where-requested": () => (
    <SetupHarness start={{ step: "where", accounts: s.nothingReady, notice: "requested" }} />
  ),
  "setup-where-suspended": () => (
    <SetupHarness start={{ step: "where", accounts: s.suspendedAccounts }} />
  ),
  "setup-where-many": () => <SetupHarness start={{ step: "where", accounts: s.manyAccounts }} />,
  "setup-where-loading": () => <SetupHarness start={{ step: "where", accounts: "loading" }} />,
  "setup-where-failed": () => <SetupHarness start={{ step: "where", accounts: "failed" }} />,
  "setup-claude": () => <SetupHarness start={{ step: "claude", card: choose }} />,
  "setup-claude-failed": () => (
    <SetupHarness start={{ step: "claude", card: { ...choose, failed: true } }} />
  ),
  "setup-paste-code": () => (
    <SetupHarness
      start={{
        step: "claude",
        card: { mode: "subscription", code: "k7Hq2-Rw9xT-pL4mZ", status: "idle" },
      }}
    />
  ),
  "setup-paste-code-connecting": () => (
    <SetupHarness
      start={{
        step: "claude",
        card: { mode: "subscription", code: "k7Hq2-Rw9xT-pL4mZ", status: "connecting" },
      }}
    />
  ),
  "setup-paste-code-wrong": () => (
    <SetupHarness
      start={{
        step: "claude",
        card: { mode: "subscription", code: "k7Hq2-Rw9xT-pL4mZ", status: "wrong" },
      }}
    />
  ),
  "setup-paste-code-expired": () => (
    <SetupHarness
      start={{ step: "claude", card: { mode: "subscription", code: "", status: "expired" } }}
    />
  ),
  "setup-api-key": () => (
    <SetupHarness start={{ step: "claude", card: { mode: "api_key", key: "", status: "idle" } }} />
  ),
  "setup-api-key-rejected": () => (
    <SetupHarness
      start={{
        step: "claude",
        card: { mode: "api_key", key: "sk-ant-api03-not-a-key", status: "rejected" },
      }}
    />
  ),
  "setup-iphone": () => <SetupHarness start={{ step: "iphone" }} />,

  "settings-account": () => <SettingsWindow section="account" />,
  "settings-agents": () => <SettingsWindow section="agents" />,
  "agents-limits": () => (
    <SettingsWindow section="agents" data={{ ...TEAM_SETTINGS, limits: s.limitsAtLimit }} />
  ),
  "settings-notifications": () => <SettingsWindow section="notifications" />,
  "settings-members": () => <SettingsWindow section="members" />,
  "settings-members-not-joined": () => (
    <SettingsWindow section="members" data={{ ...TEAM_SETTINGS, members: s.membersMixed }} />
  ),
  "settings-github": () => <SettingsWindow section="github" />,
  "settings-environments": () => <SettingsWindow section="environments" />,
  "settings-plan": () => <SettingsWindow section="plan" />,
  "settings-plan-solo": () => <SettingsWindow section="plan" data={SOLO_SETTINGS} />,
  "settings-plan-free": () => (
    <SettingsWindow
      section="plan"
      data={{
        ...TEAM_SETTINGS,
        // As the API answers today: no card, nothing billed.
        usage: { ...TEAM_SETTINGS.usage, card: null, notBilled: true },
        billingOn: false,
        byCanvas: s.byCanvas,
      }}
    />
  ),
  "settings-plan-breakdown": () => (
    <SettingsWindow
      section="plan"
      data={{
        ...TEAM_SETTINGS,
        byPerson: s.byPersonWithNobody,
        unattributedCredits: s.unattributedCredits,
        byCanvas: s.byCanvas,
      }}
    />
  ),

  "free-credits": () => <FreeCredits />,
  "free-credits-waiting": () => <FreeCredits status="waiting" />,
  "free-credits-cancelled": () => (
    <FreeCredits error="The card wasn't added. Your prompt is still here." />
  ),
  "free-credits-member": () => <FreeCredits canAddCard={false} />,
  "payment-failed": () => (
    <OnSend>
      {(dismiss, open) => (
        <PaymentFailedDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={f.thistlewick.name}
          canPay
          onPay={ignore}
        />
      )}
    </OnSend>
  ),
  "payment-failed-member": () => (
    <OnSend>
      {(dismiss, open) => (
        <PaymentFailedDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={f.thistlewick.name}
          canPay={false}
          onPay={ignore}
        />
      )}
    </OnSend>
  ),
  "add-card": () => (
    <SettingsWindowWith section="plan" data={NO_CARD_SETTINGS}>
      {(close, open) => (
        <AddCardDialog
          open={open}
          onDismiss={close}
          defaultCapUsd={100}
          status="idle"
          error={null}
          onSubmit={ignore}
          onCancel={ignore}
        />
      )}
    </SettingsWindowWith>
  ),
  "settings-plan-no-card": () => <SettingsWindow section="plan" data={NO_CARD_SETTINGS} />,
  "settings-plan-past-due": () => (
    <SettingsWindow
      section="plan"
      data={{
        ...TEAM_SETTINGS,
        usage: {
          ...TEAM_SETTINGS.usage,
          pastDue: { reason: "failed", invoiceUrl: "https://invoice.stripe.com/i/acct_1/test_1" },
        },
      }}
    />
  ),
  "cap-reached": () => (
    <OnSend>
      {(dismiss, open) => (
        <CapReachedDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={f.thistlewick.name}
          canRaise
          capUsd={500}
          billedUsd={500}
          periodEnd={s.teamUsage.periodEnd}
          status="idle"
          error={null}
          onSubmit={ignore}
        />
      )}
    </OnSend>
  ),
  "cap-reached-member": () => (
    <OnSend>
      {(dismiss, open) => (
        <CapReachedDialog
          open={open}
          onDismiss={dismiss}
          workspaceName={f.thistlewick.name}
          canRaise={false}
          capUsd={500}
          billedUsd={500}
          periodEnd={s.teamUsage.periodEnd}
          status="idle"
          error={null}
          onSubmit={ignore}
        />
      )}
    </OnSend>
  ),
  "claude-signed-out": () => <ClaudeSignedOut />,
  "claude-signed-out-code": () => (
    <ClaudeSignedOut start={{ mode: "subscription", code: "", status: "idle" }} />
  ),
  "claude-signed-out-key": () => (
    <ClaudeSignedOut
      start={{ mode: "api_key", key: "sk-ant-api03-not-a-key", status: "rejected" }}
    />
  ),
  "disconnect-claude": () => (
    <SettingsWindowWith>
      {(close, open) => <DisconnectClaudeDialog open={open} onCancel={close} onConfirm={close} />}
    </SettingsWindowWith>
  ),
  "delete-account": () => (
    <SettingsWindowWith section="account">
      {(close, open) => (
        <DeleteAccountDialog
          open={open}
          onCancel={close}
          onConfirm={close}
          login={f.ada.login}
          soleAdmin={false}
        />
      )}
    </SettingsWindowWith>
  ),
};

/** Settings on Agents (or `section`), with a dialog over it. */
function SettingsWindowWith({
  section = "agents",
  data = TEAM_SETTINGS,
  children,
}: {
  section?: "agents" | "account" | "plan";
  data?: SettingsData;
  children: (close: () => void, open: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <SettingsWindow section={section} data={data} />
      {children(() => setOpen(false), open)}
    </>
  );
}
