import { type NativeModule, requireOptionalNativeModule } from "expo";
import { useEffect, useState } from "react";

/** A service found on the local network, with its TXT record. */
export interface Service {
  name: string;
  type: string;
  domain: string;
  txt: Record<string, string>;
}

/**
 * Where a browse stands. `denied` means the person refused local network
 * access (at the prompt or in Settings); nothing will be found until they
 * allow it. `unavailable` means this build has no native module (a test, or
 * a dev client built before the module existed).
 */
export type BrowseState = "starting" | "ready" | "denied" | "failed" | "stopped" | "unavailable";

type Events = {
  onServices(event: { services: Service[] }): void;
  onState(event: { state: Exclude<BrowseState, "unavailable">; error?: string }): void;
};

declare class BonjourModule extends NativeModule<Events> {
  start(type: string): void;
  stop(): void;
}

const native = requireOptionalNativeModule<BonjourModule>("Bonjour");

/** The service type every Ponzu advertises. NSBonjourServices in app.json lists it. */
export const PONZU_SERVICE = "_ponzu._tcp";

/**
 * Browses for `type` while mounted. Only one browse runs at a time: a second
 * mounted hook takes it over. The first browse raises iOS's local network
 * prompt, so mount this only where the person expects it.
 */
export function useBonjour(type: string = PONZU_SERVICE): {
  services: Service[];
  state: BrowseState;
} {
  const [services, setServices] = useState<Service[]>([]);
  const [state, setState] = useState<BrowseState>(native ? "starting" : "unavailable");
  useEffect(() => {
    if (!native) return;
    const found = native.addListener("onServices", (event) => setServices(event.services));
    const stood = native.addListener("onState", (event) => setState(event.state));
    native.start(type);
    return () => {
      found.remove();
      stood.remove();
      native.stop();
    };
  }, [type]);
  return { services, state };
}
