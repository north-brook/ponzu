import { ArrowRight01Icon, Copy01Icon, Key01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { agentClientOf } from "@ponzu/client/model/driver";
import { type ReactNode, useEffect, useState } from "react";
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
import { type Effort, effortFor, effortsOf, type ModelOption } from "../model.ts";
import { ClaudeCard, type ClaudeCardProps, canConnect } from "../setup/claude-card.tsx";
import { StepButton } from "../setup/step.tsx";
import { ago, useNow } from "../time.ts";
import { IconButton } from "../ui/button.tsx";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import { CLAUDE_PLUGIN, claudeMcpAdd, codexMcpAdd, cursorInstallLink } from "./own-agent.ts";
import { ActionRow, Meter, QuietButton, Row, Section, TwoLine, ValuePicker } from "./parts.tsx";

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
  models: readonly ModelOption[];
  efforts: readonly Effort[];
  onDefaultsChange: (defaults: AgentDefaults) => void;
  /** The plan's windows, as last seen; null for an API key, which has none. */
  limits: ClaudeLimit[] | null;
  /** "Your own agent" and the agents connected: shown under the rest when given. */
  own?: OwnAgentProps | null;
};

/** An agent the person connected through Ponzu's MCP (`api.agents.list`). */
export interface ConnectedAgent {
  id: string;
  /** The name they allowed it as: "Claude Code". */
  name: string;
  /** What it last said it is, in its MCP `initialize`: `claude-code/2.1.0`. */
  client: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface OwnAgentProps {
  /** Ponzu's MCP on the API this app talks to (own-agent.ts, `mcpUrlOf`). */
  mcpUrl: string;
  /** The agents connected, newest first; null while they load. */
  agents: ConnectedAgent[] | null;
  /** Puts `text` on the clipboard. */
  onCopy: (text: string) => void;
  /** Opens a link outside the app: Cursor's install link. */
  onOpenLink: (url: string) => void;
  /** Disconnects one, after asking (the wiring's dialog). */
  onRevoke: (agent: ConnectedAgent) => void;
}

/**
 * Agents: which agent account is connected, the defaults a new canvas starts with, and the
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
  own = null,
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
              <TwoLine
                title="Claude was signed out"
                line="Canvases wait until you connect again."
              />
            </Row>
          )}
          {connected?.expiresAt && needsRenewal(connected, now) ? (
            <Row trailing={<QuietButton onClick={onReconnect}>Sign in</QuietButton>}>
              <span className="text-12 text-muted">
                Sign in again before {shortDate(connected.expiresAt)} to keep canvases running.
              </span>
            </Row>
          ) : null}
          <ActionRow
            leading={<Icon icon={Key01Icon} step="control" className="text-muted" />}
            icon={ArrowRight01Icon}
            onClick={onSwitch}
          >
            <span className="text-13 text-muted">
              {connection.method === "api_key"
                ? "Use a Claude subscription instead"
                : "Use an API key instead"}
            </span>
          </ActionRow>
        </Section>
      ) : null}
      <Section label="Defaults for new canvases">
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
              onChange={(model) =>
                onDefaultsChange({
                  model,
                  effort: effortFor(models, efforts, model, defaults.effort),
                })
              }
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
              options={effortsOf(models, efforts, defaults.model).map((e) => ({
                value: e,
                label: EFFORT_LABELS[e],
              }))}
              onChange={(effort) => onDefaultsChange({ ...defaults, effort })}
            />
          }
        >
          <span className="text-13 text-muted">Effort</span>
        </Row>
      </Section>
      {connected && limits ? <Limits limits={limits} connection={connected} now={now} /> : null}
      {own ? <OwnAgent {...own} now={now} /> : null}
    </>
  );
}

/**
 * Your own agent (docs/cloud.md, "Your own agent"): what it does, Ponzu's MCP to copy, how each
 * coding agent adds it, and then the agents connected, each with Revoke (asked first).
 */
export function OwnAgent({
  mcpUrl,
  agents,
  onCopy,
  onOpenLink,
  onRevoke,
  now,
}: OwnAgentProps & { now: number }) {
  return (
    <>
      <Section
        label="Your own agent"
        caption="Use your canvases from Claude Code, Codex, Cursor or T3 Code: hand work to Ponzu's agent, or drive a canvas yourself."
      >
        <Row>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1">
            <span className="font-medium text-13 text-ink">MCP server</span>
            <Command lines={[mcpUrl]} label="Copy the MCP server's URL" onCopy={onCopy} />
          </div>
        </Row>
        <ClientRow client="claude" name="Claude Code">
          <Command
            lines={CLAUDE_PLUGIN}
            label="Copy the Claude Code plugin's commands"
            onCopy={onCopy}
          />
          <span className="text-12 text-faint">Or the server alone, without Ponzu's skills:</span>
          <Command
            lines={[claudeMcpAdd(mcpUrl)]}
            label="Copy the Claude Code command"
            onCopy={onCopy}
          />
        </ClientRow>
        <ClientRow client="openai" name="Codex">
          <Command lines={codexMcpAdd(mcpUrl)} label="Copy the Codex commands" onCopy={onCopy} />
        </ClientRow>
        <Row
          leading={<AgentMark client="cursor" size={18} />}
          trailing={
            <QuietButton onClick={() => onOpenLink(cursorInstallLink(mcpUrl))}>
              Add to Cursor
            </QuietButton>
          }
        >
          <TwoLine title="Cursor" line="Opens Cursor, which asks to add Ponzu." />
        </Row>
        <Row leading={<AgentMark client="t3" size={18} />}>
          <TwoLine
            title="T3 Code"
            line="It runs Claude Code and Codex, so either setup above covers it."
          />
        </Row>
      </Section>
      <Section label="Connected agents">
        {agents === null ? null : agents.length === 0 ? (
          <Row>
            <span className="text-13 text-muted">
              None yet. An agent asks here, in Ponzu, the first time it connects.
            </span>
          </Row>
        ) : (
          agents.map((agent) => (
            <Row
              key={agent.id}
              leading={<AgentMark client={agentClientOf(agent.client)} size={18} />}
              trailing={<QuietButton onClick={() => onRevoke(agent)}>Revoke</QuietButton>}
            >
              <TwoLine title={agent.name} line={connectedLine(agent, now)} />
            </Row>
          ))
        )}
      </Section>
    </>
  );
}

/** "Connected Nov 2 · last used 3 hours ago", or "· not used yet". */
export function connectedLine(agent: ConnectedAgent, now: number): string {
  const used = agent.lastUsedAt
    ? `last used ${ago(agent.lastUsedAt, now, "long")}`
    : "not used yet";
  return `Connected ${shortDate(agent.createdAt)} · ${used}`;
}

/** A coding agent's row: its mark and name, and under them how it adds Ponzu. */
function ClientRow({
  client,
  name,
  children,
}: {
  client: string;
  name: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-rule py-2.5 not-last:border-b">
      <div className="flex items-center gap-2.5">
        <AgentMark client={client} size={18} />
        <span className="font-medium text-13 text-ink">{name}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * Words to paste into a terminal, one command a line, with a copy button that copies them all
 * and ticks for a moment.
 */
function Command({
  lines,
  label,
  onCopy,
}: {
  lines: readonly string[];
  label: string;
  onCopy: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex min-w-0 items-start gap-1 rounded-8 bg-chip py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 select-text whitespace-pre-wrap break-all py-1 font-mono text-11 text-ink leading-[1.5]">
        {lines.join("\n")}
      </code>
      <IconButton
        label={copied ? "Copied" : label}
        className="size-6 text-icon-soft hover:text-ink"
        onClick={() => {
          onCopy(lines.join("\n"));
          setCopied(true);
        }}
      >
        <Icon icon={copied ? Tick02Icon : Copy01Icon} step="small" />
      </IconButton>
    </div>
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
          ? `From ${plan}. When a limit is hit, canvases wait and Ponzu pings you when they can run again.`
          : `From ${plan}. Ponzu shows these once a canvas has run.`
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
