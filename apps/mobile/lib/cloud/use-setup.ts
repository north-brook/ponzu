import { type PhoneSetupStep, phoneSetupStep } from "@ponzu/client/model/setup";
import { useQuery } from "@tanstack/react-query";
import { useCloud } from "./query";

/**
 * Where setup stands for the person signed in, from `GET /v1/me` (kept on disk, so a launch
 * offline still knows): a step, done, or null while `me` is on its way. `unreachable`: `me`
 * could not be had and there is no copy of it.
 */
export function useSetupStep(): { step: PhoneSetupStep | null; unreachable: boolean } {
  const cloud = useCloud();
  const me = useQuery({
    ...cloud.queries.me(),
    // Asked once the copy on disk is read back, so a launch offline paints from it.
    enabled: cloud.userId !== null && !cloud.restoring,
  });
  return {
    step: me.data ? phoneSetupStep(me.data) : null,
    unreachable: !me.data && me.isError,
  };
}
