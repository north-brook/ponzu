import { useQuery } from "@tanstack/react-query";
import { ClaudeSignedOutDialog } from "../../cloud/dialogs/account-dialogs.tsx";
import type { Host } from "../host.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { useClaudeConnect } from "./claude-connect.ts";

/**
 * Connect Claude from an open design that waits on it (its owner's own Claude, not connected or
 * run out): the guided setup's card in a dialog, the same flow as first run and Settings ›
 * Agents. Once the API has it, the designs that waited on it wake (docs/cloud.md,
 * "Credentials"), and the head's live row says so.
 */
export function ConnectClaudeDialog({
  host,
  open,
  onClose,
}: {
  host: Host;
  open: boolean;
  onClose: () => void;
}) {
  const { queries } = usePonzu();
  const me = useQuery(queries.me());
  const card = useClaudeConnect({ openExternal: host.openExternal, onConnected: onClose });
  return (
    <ClaudeSignedOutDialog
      open={open}
      onDismiss={() => {
        // Closing the dialog leaves its sign-in, if one was started: it is let go of.
        card.onChange();
        onClose();
      }}
      card={card}
      connected={me.data?.claudeAccount != null}
      resume
    />
  );
}
