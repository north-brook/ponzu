import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DisconnectClaudeDialog } from "../../cloud/dialogs/account-dialogs.tsx";
import { AgentsSection } from "../../cloud/settings/agents.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { useClaudeConnect } from "../setup/claude-connect.ts";
import { toConnection } from "./map.ts";

/*
 * Settings › Agents: the person's Claude (disconnect, after asking; switch to the other way, or
 * sign in again, through the setup's own card) and the model and effort new designs start on.
 * The plan's limits are not in the API yet, so the section shows none (the spec's default).
 *
 * A claude.ai sign-in starts only when the person presses Switch or Reconnect, and is let go of
 * when they press Change or close Settings (the card goes with the section).
 */
export function AgentsView({ host }: { host: Host }) {
  const { queries, mutations } = usePonzu();
  const account = useQuery(queries.claudeAccount());
  const defaults = useQuery(queries.claudeDefaults());
  /** With a Claude connected: the person asked to connect another way, or again. */
  const [entering, setEntering] = useState(false);
  const card = useClaudeConnect({
    openExternal: host.openExternal,
    onConnected: () => setEntering(false),
  });
  const disconnect = useMutation(mutations.disconnectClaude());
  const setDefaults = useMutation(mutations.setClaudeDefaults());
  const [asking, setAsking] = useState(false);
  if (account.isPending || !defaults.data) return null;

  const connection = account.data ? toConnection(account.data) : null;
  const signInAgain = () => {
    card.openSubscription();
    setEntering(true);
  };
  const common = {
    onDisconnect: () => setAsking(true),
    onSwitch: () => {
      if (connection?.method === "subscription") {
        card.onAddKey();
        setEntering(true);
      } else {
        signInAgain();
      }
    },
    onReconnect: signInAgain,
    // While a change is on its way, the pickers show it.
    defaults: { ...defaults.data, ...setDefaults.variables },
    models: defaults.data.models,
    efforts: defaults.data.efforts,
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
            entering
              ? {
                  ...card,
                  // Change goes back to what is connected.
                  onChange: () => {
                    card.onChange();
                    setEntering(false);
                  },
                }
              : null
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
