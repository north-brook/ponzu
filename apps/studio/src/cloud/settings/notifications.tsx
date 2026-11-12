import {
  ArrowRight01Icon,
  ComputerIcon,
  Mail01Icon,
  SmartPhone01Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "../ui/icon.tsx";
import { Switch } from "../ui/switch.tsx";
import { Row, RowIcon, Section, TwoLine } from "./parts.tsx";

/** What pings the person. Pings speak as Ponzu. */
export interface PingPrefs {
  needsYou: boolean;
  replies: boolean;
  prReady: boolean;
  teammateComments: boolean;
  emailDigest: boolean;
}

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
  onPrefsChange: (prefs: PingPrefs) => void;
  devices: PingDevice[];
  onDeviceChange: (device: PingDevice, pings: boolean) => void;
  email: string | null;
  /** Ponzu can send email: the daily digest's row shows only then. */
  emailAvailable: boolean;
  /** In a team: a teammate's comment can ping. */
  team: boolean;
  /** No iPhone yet: the step that gets one. */
  onGetIphone: () => void;
}

const EVENTS: { key: Exclude<keyof PingPrefs, "emailDigest">; title: string; line: string }[] = [
  { key: "needsYou", title: "Ponzu needs you", line: "A question, a permission, a sign-in" },
  { key: "replies", title: "Ponzu replies to my comment", line: "On canvases I commented on" },
  { key: "prReady", title: "A pull request is ready", line: "Checks passed and it can merge" },
  { key: "teammateComments", title: "A teammate comments", line: "On canvases I own" },
];

/**
 * Which events ping the person, and where: each Mac (its banners while Ponzu runs) and phone,
 * and a daily email once Ponzu can send one. Saved as flipped.
 */
export function NotificationsSection({
  prefs,
  onPrefsChange,
  devices,
  onDeviceChange,
  email,
  emailAvailable,
  team,
  onGetIphone,
}: NotificationsSectionProps) {
  const events = team ? EVENTS : EVENTS.filter((e) => e.key !== "teammateComments");
  const phone = <Icon icon={SmartPhone01Icon} step="control" className="text-muted" />;
  const computer = <Icon icon={ComputerIcon} step="control" className="text-muted" />;
  const hasIphone = devices.some((device) => device.kind === "iphone");
  return (
    <>
      <Section label="Ping me when">
        {events.map(({ key, title, line }) => (
          <Row
            key={key}
            trailing={
              <Switch
                label={title}
                checked={prefs[key]}
                onCheckedChange={(on) => onPrefsChange({ ...prefs, [key]: on })}
              />
            }
          >
            <TwoLine title={title} line={line} />
          </Row>
        ))}
      </Section>
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
        {emailAvailable ? (
          <Row
            leading={<Icon icon={Mail01Icon} step="control" className="text-muted" />}
            trailing={
              <Switch
                label="Email"
                checked={prefs.emailDigest}
                onCheckedChange={(on) => onPrefsChange({ ...prefs, emailDigest: on })}
              />
            }
          >
            <TwoLine
              title="Email"
              line={email ? `${email} · a daily digest only` : "A daily digest only"}
            />
          </Row>
        ) : null}
      </Section>
    </>
  );
}
