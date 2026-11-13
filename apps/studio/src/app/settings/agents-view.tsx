import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toLimits } from "../../cloud/claude.ts";
import { DisconnectClaudeDialog, RevokeAgentDialog } from "../../cloud/dialogs/account-dialogs.tsx";
import {
  AgentsSection,
  type ConnectedAgent,
  type OwnAgentProps,
} from "../../cloud/settings/agents.tsx";
import { mcpUrlOf } from "../../cloud/settings/own-agent.ts";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { useClaudeConnect } from "../setup/claude-connect.ts";
import { toConnection } from "./map.ts";

/*
 * Settings › Agents: the person's Claude (disconnect, after asking; switch to the other way, or
 * sign in again, through the setup's own card), the model and effort new canvases start on, and
 * a subscription's limits as a runner on it last saw them (none for an API key, which has no
 * plan). Then the person's own agents (docs/cloud.md, "Your own agent"): Ponzu's MCP on the API
 * this app talks to and how each coding agent adds it, and the agents connected, each revoked
 * after asking.
 *
 * A claude.ai sign-in starts only when the person presses Switch or Reconnect, and is let go of
 * when they press Change or close Settings (the card goes with the section).
 */
export function AgentsView({ host }: { host: Host }) {
  const { api, queries, mutations } = usePonzu();
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
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: AGENTS_KEY, queryFn: () => api.agents.list() });
  const [revoking, setRevoking] = useState<ConnectedAgent | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api.agents.revoke(id),
    onSettled: () => {
      setRevoking(null);
      void queryClient.invalidateQueries({ queryKey: AGENTS_KEY });
    },
  });
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
    limits: toLimits(account.data?.limits),
    own: {
      mcpUrl: mcpUrlOf(host.session.apiUrl),
      agents: agents.data ?? null,
      onCopy: (text) => void navigator.clipboard.writeText(text).catch(() => {}),
      onOpenLink: host.openExternal,
      onRevoke: setRevoking,
    } satisfies OwnAgentProps,
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
      <RevokeAgentDialog
        name={revoking?.name ?? "this agent"}
        open={revoking !== null}
        busy={revoke.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </>
  );
}

/** The person's own agents, as `api.agents.list` answers. */
const AGENTS_KEY = ["ponzu", "agents"] as const;
