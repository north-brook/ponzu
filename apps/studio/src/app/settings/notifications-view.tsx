import { useMutation, useQuery } from "@tanstack/react-query";
import { NotificationsSection } from "../../cloud/settings/notifications.tsx";
import { useThisDevice } from "../notifications.ts";
import { usePonzu } from "../ponzu-query.tsx";
import { toPingDevices } from "./map.ts";
import { SectionUnavailable } from "./unavailable.tsx";

/*
 * Settings › Notifications: which events ping the person, each Mac and iPhone signed in as them
 * (this one first, as "This Mac"), and which emails Ponzu sends once it can send any. A toggle
 * shows flipped at once and is put back if the API turns it down. With no iPhone yet, a row leads
 * to getting one: the guided setup's own step.
 */
export function NotificationsView({
  email,
  team,
  onGetIphone,
}: {
  email: string | null;
  /** In a team: a teammate's comment can ping. */
  team: boolean;
  onGetIphone: () => void;
}) {
  const { queries, mutations } = usePonzu();
  const answer = useQuery(queries.notifications());
  const setPings = useMutation(mutations.setPings());
  const setDevice = useMutation(mutations.setDevicePings());
  const thisDevice = useThisDevice();
  if (!answer.data) {
    return answer.isError ? <SectionUnavailable onRetry={() => void answer.refetch()} /> : null;
  }
  const devices = toPingDevices(answer.data, thisDevice).map((device) =>
    setDevice.isPending && setDevice.variables.deviceId === device.id
      ? { ...device, pings: setDevice.variables.pings }
      : device,
  );
  return (
    <NotificationsSection
      prefs={answer.data.prefs}
      // Only the switch flipped, so a copy shown from before "Stop these emails" in an email
      // can't turn that email back on.
      onPrefChange={(pref, on) => setPings.mutate({ [pref]: on })}
      devices={devices}
      onDeviceChange={(device, pings) => setDevice.mutate({ deviceId: device.id, pings })}
      email={answer.data.email.address ?? email}
      emailAvailable={answer.data.email.available}
      teamAvailable={answer.data.email.teamAvailable === true}
      team={team}
      onGetIphone={onGetIphone}
    />
  );
}
