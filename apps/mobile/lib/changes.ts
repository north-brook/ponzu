import type { AgentChange } from "@ponzu/core";
import { useQuery } from "@tanstack/react-query";
import { whenAgentEdits } from "./catalog";
import { getJson, NetError } from "./http";
import { baseUrl, type Mac } from "./mac";
import { keys } from "./mac-queries";
import { macs } from "./macs";
import { queryClient } from "./query";
import { useStore } from "./store";

/**
 * `GET /api/activity`: what agents changed in the Mac's designs, newest
 * first. Null from a Mac too old to keep a history, which has no such route.
 */
export async function fetchChanges(
  mac: Pick<Mac, "dns" | "address">,
): Promise<AgentChange[] | null> {
  try {
    const body = await getJson<{ entries: AgentChange[] }>(
      `${baseUrl(mac)}/api/activity?limit=100`,
      8_000,
    );
    return body.entries;
  } catch (err) {
    if (err instanceof NetError && err.status === 404) return null;
    throw err;
  }
}

const asking = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * An agent just changed a design on `mac` (the catalog stream said so): ask
 * the Mac what, once the burst of edits settles.
 */
export function changesMoved(mac: string) {
  clearTimeout(asking.get(mac));
  asking.set(
    mac,
    setTimeout(() => {
      asking.delete(mac);
      queryClient.invalidateQueries({ queryKey: keys.activity(mac) });
    }, 1_500),
  );
}

whenAgentEdits(changesMoved);

/**
 * One Mac's change log, as the cache holds it: standby's camera falls back
 * to it when an agent goes quiet between edits.
 */
export function useMacChanges(id: string | undefined): AgentChange[] {
  const saved = useStore(macs);
  const mac = saved.find((m) => m.id === id);
  const q = useQuery({
    queryKey: keys.activity(id ?? ""),
    queryFn: () => fetchChanges(mac!),
    enabled: Boolean(mac),
    staleTime: 10_000,
  });
  return q.data ?? [];
}
