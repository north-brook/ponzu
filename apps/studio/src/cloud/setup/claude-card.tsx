/*
 * Connecting Claude: one card, a row per way to pay for it, each with its own button. Choosing
 * one turns the card into that way's entry: the code claude.ai shows after a sign-in, or an
 * Anthropic API key. Guided setup, Settings › Agents and the reconnect dialog all use it.
 */
import { ArrowUpRight01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { useId } from "react";
import { enteredKey, pastedCode } from "../claude.ts";
import { cn } from "../ui/cn.ts";
import { TextField } from "../ui/field.tsx";
import { Icon } from "../ui/icon.tsx";
import { AgentMark } from "../ui/marks.tsx";
import { MarkTile, RowButton, SetupCard, SetupRow, Waiting } from "./step.tsx";

export type ClaudeCardState =
  | {
      mode: "choose";
      /** Asking for a claude.ai sign-in: Sign in waits until its address is ready. */
      starting: boolean;
      /** The sign-in couldn't be started. */
      failed: boolean;
      /** Claude turned the start away: the person has started too many this hour. */
      limited?: boolean;
    }
  | {
      mode: "subscription";
      code: string;
      /**
       * `incomplete`: not the whole code, so it can be pasted again. `wrong`: claude.ai turned it
       * away. `used`, `expired`: the sign-in is spent. Past each of those three only Open
       * sign-in again helps. `limited`: too many sign-ins this hour, so even that waits. `failed`:
       * Claude couldn't be reached.
       */
      status:
        | "idle"
        | "connecting"
        | "incomplete"
        | "wrong"
        | "used"
        | "expired"
        | "limited"
        | "failed";
    }
  | {
      mode: "api_key";
      key: string;
      status: "idle" | "connecting" | "rejected" | "failed";
    };

/** As the API says it when a person has started too many sign-ins in an hour. */
const LIMITED = "You've started signing in to Claude several times this hour. Try again later.";

/**
 * What each failure says, in place of the field's helper. For a code, Open sign-in again
 * follows it, which is the way on from each.
 */
const ERRORS: Partial<Record<Exclude<ClaudeCardState, { mode: "choose" }>["status"], string>> = {
  incomplete: "That code isn't complete. Copy all of it.",
  wrong: "That code didn't work.",
  used: "That sign-in has been used.",
  expired: "That code has expired.",
  limited: LIMITED,
  rejected: "Anthropic didn't accept that key.",
  failed: "Couldn't reach Claude. Try again.",
};

/** A sign-in that can take no more codes: only a new one helps. */
export function signInSpent(state: ClaudeCardState): boolean {
  return (
    state.mode === "subscription" &&
    (state.status === "wrong" ||
      state.status === "used" ||
      state.status === "expired" ||
      state.status === "limited")
  );
}

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

/** Whether Connect can send what was entered. */
export function canConnect(state: ClaudeCardState): boolean {
  if (state.mode === "choose" || state.status === "connecting" || signInSpent(state)) return false;
  return (state.mode === "subscription" ? state.code : state.key).trim().length > 0;
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
            line="Pro or Max. Designs run on your plan."
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
            {state.limited ? LIMITED : "Couldn't reach Claude. Try again."}
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
}: ClaudeCardProps & { state: Exclude<ClaudeCardState, { mode: "choose" }> }) {
  const subscription = state.mode === "subscription";
  const value = subscription ? state.code : state.key;
  const connecting = state.status === "connecting";
  const error = ERRORS[state.status] ?? null;
  const label = subscription ? "Paste the code from claude.ai" : "Paste your Anthropic API key";
  const id = useId();
  return (
    <SetupCard>
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
            "m-0 text-pretty text-12",
            // The key's helper runs to two lines; its one-line error keeps them, so Connect holds.
            !subscription && "min-h-[2lh]",
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
              <button
                type="button"
                onClick={onReopen}
                disabled={connecting || reopening}
                aria-busy={reopening || undefined}
                className={cn(
                  "inline-flex cursor-default items-center gap-0.5 rounded-4 font-medium text-muted outline-none transition-colors duration-(--dur-hover) focus-ring hover:text-ink",
                  // Waiting on Claude is the turning slice, not a faded link.
                  reopening ? "disabled:opacity-100" : "disabled:opacity-35",
                )}
              >
                Open sign-in again
                {reopening ? (
                  <Waiting size={10} label="Starting a sign-in" />
                ) : (
                  <Icon icon={ArrowUpRight01Icon} size={10} stroke={2} />
                )}
              </button>
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
      <Icon icon={Key01Icon} size={16} stroke={1.8} />
    </MarkTile>
  );
}
