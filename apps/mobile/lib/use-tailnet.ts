import { useEffect, useState } from "react";
import { interfaces } from "../modules/tailnet";
import { useAppActive } from "./app-active";
import { type Tailnet, tailnet } from "./tailnet";

/** How often to look again while the screen is up: turning Tailscale on shows within a second. */
const EVERY = 1_000;

/**
 * Whether this iPhone is on a tailnet, looked at again every second while
 * the app is in front, and at once on coming back to it (from the Tailscale
 * app, say). Reading the interfaces is cheap and never touches the network.
 */
export function useTailnet(): Tailnet {
  const active = useAppActive();
  const [state, setState] = useState<Tailnet>(() => tailnet(interfaces()));
  useEffect(() => {
    if (!active) return;
    const look = () => setState(tailnet(interfaces()));
    look();
    const t = setInterval(look, EVERY);
    return () => clearInterval(t);
  }, [active]);
  return state;
}
