import { useCloud } from "../lib/cloud/query";
import { useGate } from "../lib/cloud/use-gate";

/**
 * Moves the app when the session or setup changes under it (lib/cloud/use-gate.ts). It stays
 * mounted for the app's life, above the screens, while each sign-in brings a new QueryClient
 * (lib/cloud/query.tsx). A query hook stays with the client it first mounted on, so the gate
 * starts again for each person: otherwise, after a sign-in, it would read `me` from the client
 * of whoever was there before (nobody, at a first sign-in) and never hear a step done.
 */
export function Gate() {
  const { userId } = useCloud();
  return <PersonGate key={userId ?? "signed-out"} />;
}

function PersonGate() {
  useGate();
  return null;
}
