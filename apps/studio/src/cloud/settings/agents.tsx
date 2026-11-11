import { ArrowRight01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import {
  type ClaudeConnection,
  type ClaudeLimit,
  connectionLine,
  isSignedOut,
  LIMIT_TITLES,
  limitView,
  needsRenewal,
  shortDate,
} from "../claude.ts";
import { EFFORT_LABELS } from "../create/model-picker.tsx";
import type { Effort, ModelOption } from "../model.ts";
import { ClaudeCard, type ClaudeCardProps, canConnect } from "../setup/claude-card.tsx";
import { StepButton } from "../setup/step.tsx";
import { useNow } from "../time.ts";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import { Meter, QuietButton, Row, RowIcon, Section, TwoLine, ValuePicker } from "./parts.tsx";

export interface AgentDefaults {
  model: string;
  effort: Effort;
}

/**
 * The person's Claude, and the setup's card in place of its rows while connecting one. With
 * nothing connected there is always the card, so the section always offers a way to connect;
 * with one connected, `entry` is switching to the other way, and null shows what is connected.
 */
export type AgentsConnection =
  | { connection: null; entry: ClaudeCardProps }
  | { connection: ClaudeConnection; entry: ClaudeCardProps | null };

export type AgentsSectionProps = AgentsConnection & {
  onDisconnect: () => void;
  /** Connect the other way instead of the one connected: the wiring opens `entry` on it. */
  onSwitch: () => void;
  /** Sign in again: a subscription near its year's end, or one signed out. */
  onReconnect: () => void;
  defaults: AgentDefaults;
  models: ModelOption[];
  efforts: Effort[];
  onDefaultsChange: (defaults: AgentDefaults) => void;
  /** The plan's windows, as last seen; null for an API key, which has none. */
  limits: ClaudeLimit[] | null;
};

/**
 * Agents: which agent account is connected, the defaults a new design starts with, and the
 * Claude plan's own limits. Claude Code is the one agent today.
 */
export function AgentsSection({
  connection,
  entry,
  onDisconnect,
  onSwitch,
  onReconnect,
  defaults,
  models,
  efforts,
  onDefaultsChange,
  limits,
}: AgentsSectionProps) {
  const now = useNow();
  const connected = connection && !isSignedOut(connection) ? connection : null;
  return (
    <>
      {entry ? (
        <section aria-label="Connect Claude" className="flex flex-col gap-3">
          <ClaudeCard {...entry} />
          {entry.state.mode === "choose" ? null : (
            <div className="flex justify-end">
              <StepButton
                onClick={entry.onSubmit}
                disabled={!canConnect(entry.state)}
                busy={entry.state.status === "connecting"}
              >
                Connect
              </StepButton>
            </div>
          )}
        </section>
      ) : connection ? (
        <Section label="Connected">
          {connected ? (
            <Row
              leading={<AgentMark client="claude" size={18} />}
              trailing={<QuietButton onClick={onDisconnect}>Disconnect</QuietButton>}
            >
              <TwoLine title="Claude Code" line={connectionLine(connected)} />
            </Row>
          ) : (
            <Row
              leading={<AgentMark client="claude" size={18} />}
              trailing={<QuietButton onClick={onReconnect}>Reconnect</QuietButton>}
            >
              <TwoLine title="Claude was signed out" line="Designs wait until you connect again." />
            </Row>
          )}
          {connected?.expiresAt && needsRenewal(connected, now) ? (
            <Row trailing={<QuietButton onClick={onReconnect}>Sign in</QuietButton>}>
              <span className="text-12 text-muted">
                Sign in again before {shortDate(connected.expiresAt)} to keep designs running.
              </span>
            </Row>
          ) : null}
          <Row
            leading={<Icon icon={Key01Icon} size={16} stroke={1.8} className="text-faint" />}
            trailing={<RowIcon icon={ArrowRight01Icon} label="Switch" onClick={onSwitch} />}
          >
            <span className="text-13 text-muted">
              {connection.method === "api_key"
                ? "Use a Claude subscription instead"
                : "Use an API key instead"}
            </span>
          </Row>
        </Section>
      ) : null}
      <Section label="Defaults for new designs">
        <Row
          trailing={
            <ValuePicker
              label="Agent"
              value="claude_code"
              options={[{ value: "claude_code", label: "Claude Code" }]}
              onChange={() => {}}
              leading={<AgentMark client="claude" size={13} />}
            />
          }
        >
          <span className="text-13 text-muted">Agent</span>
        </Row>
        <Row
          trailing={
            <ValuePicker
              label="Model"
              value={defaults.model}
              options={models.map((m) => ({ value: m.id, label: m.label }))}
              onChange={(model) => onDefaultsChange({ ...defaults, model })}
            />
          }
        >
          <span className="text-13 text-muted">Model</span>
        </Row>
        <Row
          trailing={
            <ValuePicker
              label="Effort"
              value={defaults.effort}
              options={efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] }))}
              onChange={(effort) => onDefaultsChange({ ...defaults, effort })}
            />
          }
        >
          <span className="text-13 text-muted">Effort</span>
        </Row>
      </Section>
      {connected && limits ? <Limits limits={limits} connection={connected} now={now} /> : null}
    </>
  );
}

function Limits({
  limits,
  connection,
  now,
}: {
  limits: ClaudeLimit[];
  connection: ClaudeConnection;
  now: number;
}) {
  const plan = connection.planLabel ? `your ${connection.planLabel} plan` : "your Claude plan";
  const seen = limits.some((l) => l.utilization !== null);
  return (
    <Section
      label="Limits"
      note={
        seen
          ? `From ${plan}. When a limit is hit, designs wait and Ponzu pings you when they can run again.`
          : `From ${plan}. Ponzu shows these once a design has run.`
      }
    >
      {limits.map((limit) => {
        const view = limitView(limit, now);
        const title = LIMIT_TITLES[limit.window];
        return (
          <Row
            key={limit.window}
            trailing={
              <div className="flex w-[180px] flex-col items-end gap-1.5">
                <span className="font-medium font-mono text-12 text-ink leading-none">
                  {view.percent === null ? "—" : `${view.percent}%`}
                </span>
                <Meter value={view.percent} label={title} />
              </div>
            }
          >
            <TwoLine title={title} line={view.line} />
          </Row>
        );
      })}
    </Section>
  );
}
