import { type NativeModule, requireOptionalNativeModule } from "expo";

/** An address on one of the phone's network interfaces, e.g. `{ name: "utun4", address: "100.101.102.103" }`. */
export interface Interface {
  name: string;
  address: string;
}

declare class TailnetModule extends NativeModule {
  interfaces(): Interface[];
}

const native = requireOptionalNativeModule<TailnetModule>("Tailnet");

/**
 * Every address on an interface that's up, or null when this build has no
 * native module (a test, or a dev client built before the module existed).
 */
export function interfaces(): Interface[] | null {
  if (!native) return null;
  try {
    return native.interfaces();
  } catch {
    return null;
  }
}
