import { ArrowRight01Icon, ComputerIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "../ui/icon.tsx";
import { Switch } from "../ui/switch.tsx";
import { Row, RowIcon, Section, TwoLine } from "./parts.tsx";

/** What pings the person, and which emails Ponzu sends them. Pings speak as Ponzu. */
export interface PingPrefs {
  needsYou: boolean;
  replies: boolean;
  prReady: boolean;
  teammateComments: boolean;
  emailDigest: boolean;
  /**
   * The "people joined" email. The API answers it only while it can send email, so an older API,
   * or one with email off, leaves it out and its row with it.
   */
  emailTeam?: boolean;
  /** The Friday recap. Answered only while the API can send email, like `emailTeam`. */
  emailRecap?: boolean;
}

/** A switch Settings › Notifications flips. */
export type PingPref = keyof PingPrefs;

/** A Mac or an iPhone signed in as the person. */
export interface PingDevice {
  id: string;
  kind: "mac" | "iphone";
  /** "This Mac", "Maya's MacBook Pro", "iPhone 16 Pro" */
  name: string;
  pings: boolean;
  /** iOS turned notifications off for Ponzu: nothing can be sent until the person turns them on there. */
  blocked: boolean;
}

export interface NotificationsSectionProps {
  prefs: PingPrefs;
  /**
   * One switch flipped. Only that switch is saved, never the rest of `prefs` as shown: a copy
   * shown from before an email's "Stop these emails" would turn that email back on.
   */
  onPrefChange: (pref: PingPref, on: boolean) => void;
  devices: PingDevice[];
  onDeviceChange: (device: PingDevice, pings: boolean) => void;
  /** Where email goes: the person's GitHub email. */
  email: string | null;
  /** Ponzu can send email: the Email group shows only then. */
  emailAvailable: boolean;
  /**
   * The "people joined" email could reach the person (an admin of an organisation's workspace who
   * reaches it on GitHub as its owner or a member): its row shows only then.
   */
  teamAvailable: boolean;
  /** In a team: a teammate's comment can ping. */
  team: boolean;
  /** No iPhone yet: the step that gets one. */
  onGetIphone: () => void;
}

type Toggle<K extends PingPref> = { key: K; title: string; line: string };

const EVENTS: Toggle<"needsYou" | "replies" | "prReady" | "teammateComments">[] = [
  { key: "needsYou", title: "Ponzu needs you", line: "A question, a permission, a sign-in" },
  { key: "replies", title: "Ponzu replies to my comment", line: "On canvases I commented on" },
  { key: "prReady", title: "A pull request is ready", line: "Checks passed and it can merge" },
  { key: "teammateComments", title: "A teammate comments", line: "On canvases I own" },
];

/** The Email group's switches, in the words docs/cloud.md ("Email") gives them. */
export const EMAILS: Toggle<"emailDigest" | "emailRecap" | "emailTeam">[] = [
  { key: "emailDigest", title: "Daily digest", line: "What you missed, once a day at 9." },
  {
    key: "emailRecap",
    title: "Friday recap",
    line: "What you shipped, in weeks something merged.",
  },
  { key: "emailTeam", title: "When people join", line: "Workspaces you're an admin of." },
];

/** Under the Email group's rows: billing emails have no switch. */
export const BILLING_EMAILS = "Billing emails go to every admin and can't be turned off.";

/** Under the Email group's label: where its emails go. */
export const emailsGoTo = (address: string | null) =>
  address ? `Emails go to ${address}, your GitHub email.` : "Emails go to your GitHub email.";

/**
 * Which events ping the person, and where: each Mac (its banners while Ponzu runs) and phone.
 * Once Ponzu can send email, which emails it sends them. Saved as flipped, one switch at a time.
 */
export function NotificationsSection({
  prefs,
  onPrefChange,
  devices,
  onDeviceChange,
  email,
  emailAvailable,
  teamAvailable,
  team,
  onGetIphone,
}: NotificationsSectionProps) {
  const events = team ? EVENTS : EVENTS.filter((e) => e.key !== "teammateComments");
  // A switch the API did not answer has no row: an API without email's kinds, or a person the
  // "people joined" email could not reach.
  const emails = EMAILS.filter(
    ({ key }) => prefs[key] !== undefined && (key !== "emailTeam" || teamAvailable),
  );
  const phone = <Icon icon={SmartPhone01Icon} step="control" className="text-muted" />;
  const computer = <Icon icon={ComputerIcon} step="control" className="text-muted" />;
  const hasIphone = devices.some((device) => device.kind === "iphone");
  const toggle = ({ key, title, line }: Toggle<PingPref>) => (
    <Row
      key={key}
      trailing={
        <Switch
          label={title}
          checked={prefs[key] === true}
          onCheckedChange={(on) => onPrefChange(key, on)}
        />
      }
    >
      <TwoLine title={title} line={line} />
    </Row>
  );
  return (
    <>
      <Section label="Ping me when">{events.map(toggle)}</Section>
      <Section label="Where">
        {devices.map((device) => (
          <Row
            key={device.id}
            leading={device.kind === "mac" ? computer : phone}
            trailing={
              <Switch
                label={device.name}
                checked={device.pings && !device.blocked}
                disabled={device.blocked}
                onCheckedChange={(on) => onDeviceChange(device, on)}
              />
            }
          >
            <TwoLine
              title={device.name}
              line={device.blocked ? "Turned off in iOS Settings" : "Pings"}
            />
          </Row>
        ))}
        {hasIphone ? null : (
          <Row
            leading={phone}
            trailing={
              <RowIcon
                icon={ArrowRight01Icon}
                label="Get Ponzu on your iPhone"
                onClick={onGetIphone}
              />
            }
          >
            <TwoLine title="iPhone" line="Get Ponzu on your iPhone" />
          </Row>
        )}
      </Section>
      {emailAvailable ? (
        <Section label="Email" caption={emailsGoTo(email)} note={BILLING_EMAILS}>
          {emails.map(toggle)}
        </Section>
      ) : null}
    </>
  );
}
