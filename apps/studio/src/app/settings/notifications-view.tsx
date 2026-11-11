import { useMutation, useQuery } from "@tanstack/react-query";
import { NotificationsSection } from "../../cloud/settings/notifications.tsx";
import { usePonzu } from "../ponzu-query.tsx";
import { toPingDevices } from "./map.ts";
import { SectionUnavailable } from "./unavailable.tsx";

/*
 * Settings › Notifications: which events ping the person, each iPhone signed in as them, and the
 * daily email. A toggle shows flipped at once and is put back if the API turns it down. With no
 * iPhone yet, the row leads to getting one: the guided setup's own step.
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
  if (!answer.data) {
    return answer.isError ? <SectionUnavailable onRetry={() => void answer.refetch()} /> : null;
  }
  const devices = toPingDevices(answer.data).map((device) =>
    setDevice.isPending && setDevice.variables.deviceId === device.id
      ? { ...device, pings: setDevice.variables.pings }
      : device,
  );
  return (
    <NotificationsSection
      prefs={answer.data.prefs}
      onPrefsChange={(prefs) => setPings.mutate(prefs)}
      devices={devices}
      onDeviceChange={(device, pings) => setDevice.mutate({ deviceId: device.id, pings })}
      email={email}
      team={team}
      onGetIphone={onGetIphone}
    />
  );
}
