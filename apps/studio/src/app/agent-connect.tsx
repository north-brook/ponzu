import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BlockingDialog,
  DialogActions,
  DialogButton,
  DialogError,
} from "../cloud/dialogs/blocking-dialog.tsx";
import type { Host } from "./host.ts";
import { usePonzu } from "./ponzu-query.tsx";

/*
 * A person's own agent asks to use Ponzu as them (docs/cloud.md, "Your own agent"): its sign-in
 * opened `<scheme>://agents/connect?request=<id>`, and this asks the person. Allowing or
 * refusing answers where the agent waits for the outcome (its redirect, usually a port on this
 * Mac), which the system browser opens, as the agent's own sign-in page would have.
 *
 * The name is the agent's own word: anything can register as "Claude Code". So the dialog also
 * says where the answer goes, and says so plainly when that isn't this computer.
 */

export function AgentConnectDialog({
  host,
  requestId,
  onDone,
}: {
  host: Host;
  requestId: string;
  /** The question is answered, refused or over: the dialog goes. */
  onDone: (outcome: "allowed" | "refused" | "dismissed") => void;
}) {
  const { api } = usePonzu();
  const ask = useQuery({
    queryKey: ["agent-connect", requestId],
    queryFn: () => api.agents.request(requestId),
    retry: false,
  });
  const decide = useMutation({
    mutationFn: async (allow: boolean) => {
      const { redirectUrl } = allow
        ? await api.agents.approve(requestId)
        : await api.agents.deny(requestId);
      host.openExternal(redirectUrl);
      return allow;
    },
    onSuccess: (allowed) => onDone(allowed ? "allowed" : "refused"),
  });

  const name = ask.data?.name ?? "An agent";
  const over = ask.isError;
  const title = over ? "This request is over" : `Allow ${name} to use Ponzu?`;
  const body = over
    ? "It was answered already, or 15 minutes passed. Ask your agent to connect again."
    : [
        `${name} will be able to see and steer the canvases you can, start canvases in your workspaces, and drive a canvas in place of Ponzu's agent. What it sends in a thread says it came from it.`,
        ask.data && !ask.data.loopback
          ? `It isn't on this Mac: its answer goes to ${ask.data.redirectHost}. Allow it only if you started this.`
          : "You can disconnect it any time in Settings › Agents.",
      ].join(" ");

  return (
    <BlockingDialog
      open={!ask.isPending}
      onDismiss={() => onDone("dismissed")}
      title={title}
      body={body}
    >
      <DialogError>{decide.error ? decide.error.message : null}</DialogError>
      <DialogActions>
        {over ? (
          <DialogButton tone="primary" onClick={() => onDone("dismissed")}>
            OK
          </DialogButton>
        ) : (
          <>
            <DialogButton
              tone="raised"
              onClick={() => decide.mutate(false)}
              disabled={decide.isPending}
            >
              Don't allow
            </DialogButton>
            <DialogButton
              tone="primary"
              onClick={() => decide.mutate(true)}
              busy={decide.isPending && decide.variables === true}
            >
              Allow
            </DialogButton>
          </>
        )}
      </DialogActions>
    </BlockingDialog>
  );
}
