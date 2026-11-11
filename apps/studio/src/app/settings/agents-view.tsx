import type { Api } from "@ponzu/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ClaudeConnection } from "../../cloud/claude.ts";
import { DisconnectClaudeDialog } from "../../cloud/dialogs/account-dialogs.tsx";
import { AgentsSection } from "../../cloud/settings/agents.tsx";
import type { ClaudeCardState } from "../../cloud/setup/claude-card.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { CHOOSING, useClaudeConnect } from "../setup/claude-connect.ts";
import { toConnection } from "./map.ts";

/*
 * Settings › Agents: the person's Claude (disconnect, after asking; switch to the other way, or
 * sign in again, through the setup's own card) and the model and effort new designs start on.
 * The plan's limits are not in the API yet, so the section shows none (the spec's default).
 */

type Defaults = Awaited<ReturnType<Api["claude"]["defaults"]>>;

/** Switching to a key: its field. Switching to a subscription, or signing in again: claude.ai. */
const KEY_ENTRY: ClaudeCardState = { mode: "api_key", key: "", status: "idle" };
const SIGNING_IN: ClaudeCardState = { mode: "subscription", code: "", status: "idle" };

/** The card, when the person asked to connect another way or again: where it starts. */
type Entry = { key: number; start: ClaudeCardState } | null;

export function AgentsView({ host }: { host: Host }) {
  const { queries } = usePonzu();
  const account = useQuery(queries.claudeAccount());
  const defaults = useQuery(queries.claudeDefaults());
  const [entry, setEntry] = useState<Entry>(null);
  if (account.isPending || !defaults.data) return null;
  return (
    <AgentsBody
      // Each time the card is asked for, it starts over.
      key={entry?.key ?? 0}
      host={host}
      connection={account.data ? toConnection(account.data) : null}
      start={entry?.start ?? null}
      onEntry={(start) => setEntry((was) => ({ key: (was?.key ?? 0) + 1, start }))}
      onEntryDone={() => setEntry(null)}
      defaults={defaults.data}
    />
  );
}

function AgentsBody({
  host,
  connection,
  start,
  onEntry,
  onEntryDone,
  defaults,
}: {
  host: Host;
  connection: ClaudeConnection | null;
  /** Where the card starts; null shows what is connected. With nothing connected, the card. */
  start: ClaudeCardState | null;
  onEntry: (start: ClaudeCardState) => void;
  onEntryDone: () => void;
  defaults: Defaults;
}) {
  const { mutations } = usePonzu();
  const card = useClaudeConnect({
    openExternal: host.openExternal,
    onConnected: onEntryDone,
    initial: start ?? CHOOSING,
  });
  const disconnect = useMutation(mutations.disconnectClaude());
  const setDefaults = useMutation(mutations.setClaudeDefaults());
  const [asking, setAsking] = useState(false);

  const common = {
    onDisconnect: () => setAsking(true),
    onSwitch: () => onEntry(connection?.method === "subscription" ? KEY_ENTRY : SIGNING_IN),
    onReconnect: () => onEntry(SIGNING_IN),
    // While a change is on its way, the pickers show it.
    defaults: { ...defaults, ...setDefaults.variables },
    models: defaults.models,
    efforts: defaults.efforts,
    onDefaultsChange: setDefaults.mutate,
    limits: null,
  };
  return (
    <>
      {connection ? (
        <AgentsSection
          {...common}
          connection={connection}
          entry={
            start === null
              ? null
              : {
                  ...card,
                  // Change goes back to what is connected.
                  onChange: () => {
                    card.onChange();
                    onEntryDone();
                  },
                }
          }
        />
      ) : (
        <AgentsSection {...common} connection={null} entry={card} />
      )}
      <DisconnectClaudeDialog
        open={asking}
        busy={disconnect.isPending}
        onCancel={() => setAsking(false)}
        onConfirm={() => disconnect.mutate(undefined, { onSettled: () => setAsking(false) })}
      />
    </>
  );
}
