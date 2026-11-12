import type { PhoneSetupStep } from "@ponzu/client/model/setup";
import { useEffect } from "react";
import { gateStep } from "../lib/cloud/gate";
import { useCloud } from "../lib/cloud/query";
import { useGate } from "../lib/cloud/use-gate";
import { useSetupStep } from "../lib/cloud/use-setup";

/*
 * Each sign-in brings a new QueryClient (lib/cloud/query.tsx), while what is mounted above the
 * screens, or on screen as the session changes, stays. A query hook stays with the client it
 * first mounted on, so what reads `me` across a sign-in is keyed by the person: otherwise it
 * would read `me` from the client of whoever was there before (nobody, at a first sign-in or
 * while the Keychain is read at launch), never hear a step done, and never see the copy on disk.
 */

/** Moves the app when the session or setup changes under it (lib/cloud/use-gate.ts). */
export function Gate() {
  const { userId } = useCloud();
  return <PersonGate key={userId ?? "signed-out"} />;
}

function PersonGate() {
  useGate();
  return null;
}

/**
 * Hands `onStep` the setup step the gates go by (`gateStep`), read on the signed-in person's
 * own client, for a screen that stays mounted across the sign-in (the launch screen).
 */
export function SetupStepReader({ onStep }: { onStep: (step: PhoneSetupStep | null) => void }) {
  const { userId } = useCloud();
  return <PersonSetupStep key={userId ?? "signed-out"} onStep={onStep} />;
}

function PersonSetupStep({ onStep }: { onStep: (step: PhoneSetupStep | null) => void }) {
  const step = gateStep(useSetupStep());
  useEffect(() => onStep(step), [step, onStep]);
  return null;
}
