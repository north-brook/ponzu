/*
 * Connecting Claude: one card, a row per way to pay for it, each with its own button. Choosing
 * one turns the card into that way's entry: the code claude.ai shows after a sign-in, or an
 * Anthropic API key. Guided setup, Settings › Agents and the reconnect dialog all use it.
 */
import { Key01Icon } from "@hugeicons/core-free-icons";
import {
  CLAUDE_LIMITED,
  CLAUDE_UNREACHABLE,
  type ClaudeCardState,
  type ClaudeEntry,
  canConnect,
  entryError,
  signInSpent,
} from "@ponzu/client/model/claude-entry";
import { useId } from "react";
import { enteredKey, pastedCode } from "../claude.ts";
import { cn } from "../ui/cn.ts";
import { ExternalLink } from "../ui/external-link.tsx";
import { TextField } from "../ui/field.tsx";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import { MarkTile, RowButton, SetupCard, SetupRow, Waiting } from "./step.tsx";

export type { ClaudeCardState };
// The states and their words are shared with the phone (@ponzu/client/model/claude-entry).
export { canConnect, signInSpent };

export interface ClaudeCardProps {
  state: ClaudeCardState;
  /** Start a claude.ai sign-in and open it in the browser. */
  onSignIn: () => void;
  onAddKey: () => void;
  /** Back to the two ways; a pending sign-in is abandoned. */
  onChange: () => void;
  /**
   * The code or key as entered: a paste of the code arrives lifted from its words, and a key
   * without whitespace, so what is held can be sent as it is.
   */
  onInput: (text: string) => void;
  /** Start a new sign-in and open claude.ai again; the code is cleared. */
  onReopen: () => void;
  /** A new sign-in is being started: Open sign-in again waits until claude.ai opens. */
  reopening?: boolean;
  onSubmit: () => void;
}

export function ClaudeCard(props: ClaudeCardProps) {
  const { state } = props;
  if (state.mode === "choose") {
    return (
      <>
        <SetupCard>
          <SetupRow
            mark={<ClaudeTile />}
            title="Claude Subscription"
            line="Pro or Max. Canvases run on your plan."
          >
            <RowButton tone="primary" leaves busy={state.starting} onClick={props.onSignIn}>
              Sign in
            </RowButton>
          </SetupRow>
          <SetupRow
            mark={<KeyTile />}
            title="Anthropic API key"
            line="Pay per token through the Console."
          >
            <RowButton tone="raised" onClick={props.onAddKey}>
              Add key
            </RowButton>
          </SetupRow>
        </SetupCard>
        {state.failed || state.limited ? (
          <p role="alert" className="m-0 pt-3.5 text-center text-12 text-danger">
            {state.limited ? CLAUDE_LIMITED : CLAUDE_UNREACHABLE}
          </p>
        ) : null}
      </>
    );
  }
  return <MethodEntry {...props} state={state} />;
}

function MethodEntry({
  state,
  onChange,
  onInput,
  onReopen,
  reopening = false,
  onSubmit,
}: ClaudeCardProps & { state: ClaudeEntry }) {
  const subscription = state.mode === "subscription";
  const value = subscription ? state.code : state.key;
  const connecting = state.status === "connecting";
  const error = entryError(state);
  const label = subscription ? "Paste the code from claude.ai" : "Paste your Anthropic API key";
  const id = useId();
  return (
    // The code or the key, as it is pasted: never recorded (app/analytics/privacy.ts).
    <SetupCard className="ph-no-capture">
      <div className="flex items-center gap-2.5 px-4 py-3">
        {subscription ? <ClaudeTile /> : <KeyTile />}
        <span className="flex-1 font-medium text-14 text-ink">
          {subscription ? "Claude Subscription" : "Anthropic API key"}
        </span>
        <button
          type="button"
          onClick={onChange}
          disabled={connecting}
          className="cursor-default rounded-4 font-medium text-12 text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-ink disabled:opacity-35"
        >
          Change
        </button>
      </div>
      <div className="mx-4 h-px bg-rule" />
      <form
        className="flex flex-col gap-2 px-4 pt-3.5 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canConnect(state)) onSubmit();
        }}
      >
        <label htmlFor={id} className="font-medium text-13 text-ink">
          {label}
        </label>
        <TextField
          id={id}
          // Focused as the card opens: the person has just been sent here to paste.
          autoFocus
          mono={subscription}
          type={subscription ? "text" : "password"}
          placeholder={subscription ? undefined : "sk-ant-…"}
          value={value}
          readOnly={connecting}
          invalid={error !== null}
          aria-describedby={`${id}-help`}
          onChange={(e) => onInput(subscription ? e.target.value : enteredKey(e.target.value))}
          onPaste={(e) => {
            if (!subscription) return;
            e.preventDefault();
            onInput(pastedCode(e.clipboardData.getData("text")));
          }}
        />
        <p
          id={`${id}-help`}
          role={error ? "alert" : undefined}
          className={cn(
            "m-0 text-12",
            // The code's line wraps evenly. The key's helper fills the card's width and may run
            // to two lines; its one-line error keeps them, so Connect holds.
            subscription ? "text-pretty" : "min-h-[2lh]",
            error ? "text-danger" : "text-faint",
          )}
        >
          {error ??
            (subscription
              ? "claude.ai shows it after you approve."
              : "Usage bills to your Anthropic Console account. Ponzu stores the key encrypted.")}
          {subscription ? (
            <>
              {" "}
              <ExternalLink
                onClick={onReopen}
                disabled={connecting || reopening}
                aria-busy={reopening || undefined}
                trailing={reopening ? <Waiting size={10} label="Starting a sign-in" /> : undefined}
                className={cn(
                  "gap-0.5 font-medium",
                  // Waiting on Claude is the turning slice, not a faded link.
                  reopening ? "disabled:opacity-100" : "disabled:opacity-35",
                )}
              >
                Open sign-in again
              </ExternalLink>
            </>
          ) : null}
        </p>
      </form>
    </SetupCard>
  );
}

function ClaudeTile() {
  return (
    <MarkTile>
      <AgentMark client="claude" size={17} />
    </MarkTile>
  );
}

function KeyTile() {
  return (
    <MarkTile>
      <Icon icon={Key01Icon} step="control" />
    </MarkTile>
  );
}
